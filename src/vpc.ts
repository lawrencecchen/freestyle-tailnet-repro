import {
  bashScript,
  createVm,
  deleteVpcBestEffort,
  deleteVms,
  execText,
  freestyleClient,
  randomPrivateCidr24,
  redact,
  requireFreestyleApiKey,
  shellSingleQuote,
} from "./lib.js";

requireFreestyleApiKey();

const runId = `fs-vpc-${Date.now().toString(36)}`;
const cidr = process.env.FREESTYLE_VPC_CIDR ?? randomPrivateCidr24();
const [ipA, ipB] = privateIpsForCidr24(cidr);
const client = freestyleClient();
const vmIds: string[] = [];
let vpcId: string | null = null;
let cleanupStarted = false;

installSignalCleanup();

try {
  console.log("== create VPC ==");
  const createdVpc = await client.vpc.create({
    name: runId,
    cidr,
  });
  vpcId = createdVpc.vpcId;
  console.log(`vpc_id=${vpcId}`);
  console.log(`vpc_cidr=${cidr}`);

  console.log("\n== create two private VPC VMs ==");
  const [a, b] = await createVmPair([
    createTrackedVm({
      idleTimeoutSeconds: 300,
      persistence: { type: "ephemeral" },
      ports: [],
      nics: [{ default: true, vpc: vpcId, mode: "routed", ipv4: ipA }],
    }),
    createTrackedVm({
      idleTimeoutSeconds: 300,
      persistence: { type: "ephemeral" },
      ports: [],
      nics: [{ default: true, vpc: vpcId, mode: "routed", ipv4: ipB }],
    }),
  ]);
  console.log(`worker_a=${a.vmId}`);
  console.log(`worker_b=${b.vmId}`);
  console.log(`worker_a_private_ip=${ipA}`);
  console.log(`worker_b_private_ip=${ipB}`);
  console.log(`worker_a_domains=${a.domains.length}`);
  console.log(`worker_b_domains=${b.domains.length}`);

  console.log("\n== install probe tools ==");
  const [installA, installB] = await Promise.all([
    execText(a.vm, installToolsScript(), 180_000),
    execText(b.vm, installToolsScript(), 180_000),
  ]);
  console.log("[a]\n" + redact(installA));
  console.log("[b]\n" + redact(installB));
  assertMarker(installA, "INSTALL_TOOLS_OK", "install probe tools on worker A");
  assertMarker(installB, "INSTALL_TOOLS_OK", "install probe tools on worker B");

  console.log("\n== private interface diagnostics ==");
  const [diagA, diagB] = await Promise.all([
    execText(a.vm, networkProbeScript(ipA), 60_000),
    execText(b.vm, networkProbeScript(ipB), 60_000),
  ]);
  console.log("[a]\n" + redact(diagA));
  console.log("[b]\n" + redact(diagB));

  console.log("\n== worker-to-worker ping over VPC ==");
  const [pingAtoB, pingBtoA] = await Promise.all([
    execText(a.vm, pingPeerScript(ipB), 45_000),
    execText(b.vm, pingPeerScript(ipA), 45_000),
  ]);
  console.log("[a -> b ping]\n" + redact(pingAtoB));
  console.log("[b -> a ping]\n" + redact(pingBtoA));

  console.log("\n== worker-to-worker TCP over VPC ==");
  const [serverA, serverB] = await Promise.all([
    execText(a.vm, httpServerScript("a"), 30_000),
    execText(b.vm, httpServerScript("b"), 30_000),
  ]);
  console.log("[server a]\n" + redact(serverA));
  console.log("[server b]\n" + redact(serverB));

  const [tcpAtoB, tcpBtoA] = await Promise.all([
    execText(a.vm, curlPeerScript(ipB), 60_000),
    execText(b.vm, curlPeerScript(ipA), 60_000),
  ]);
  console.log("[a -> b http]\n" + redact(tcpAtoB));
  console.log("[b -> a http]\n" + redact(tcpBtoA));

  console.log("\nsummary:");
  console.log(`vpc_id=${vpcId}`);
  console.log(`vpc_cidr=${cidr}`);
  console.log(`vpc_private_ips=${ipA},${ipB}`);
  console.log(`vpc_private_ip_present=${/PRIVATE_IP_PRESENT/.test(diagA) && /PRIVATE_IP_PRESENT/.test(diagB) ? "yes" : "no"}`);
  console.log(`vpc_ping=${/PING_OK/.test(pingAtoB) && /PING_OK/.test(pingBtoA) ? "yes" : "no"}`);
  console.log(`vpc_tcp=${/hello-from-b/.test(tcpAtoB) && /hello-from-a/.test(tcpBtoA) ? "yes" : "no"}`);
} finally {
  await cleanupResources();
}

async function createTrackedVm(options: Parameters<typeof createVm>[1]): ReturnType<typeof createVm> {
  const created = await createVm(client, options);
  vmIds.push(created.vmId);
  return created;
}

async function createVmPair<T>(promises: [Promise<T>, Promise<T>]): Promise<[T, T]> {
  const results = await Promise.allSettled(promises);
  const failures = results
    .map((result, index) => result.status === "rejected" ? `worker_${index === 0 ? "a" : "b"}: ${errorMessage(result.reason)}` : null)
    .filter((message): message is string => Boolean(message));
  if (failures.length > 0) {
    throw new Error(`Failed to create private VPC VMs: ${failures.join("; ")}`);
  }
  return results.map((result) => (result as PromiseFulfilledResult<T>).value) as [T, T];
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

async function cleanupResources(): Promise<void> {
  if (cleanupStarted) return;
  cleanupStarted = true;
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
  await deleteVms(client, vmIds);
  if (process.env.FREESTYLE_KEEP_VPC === "1") {
    console.log(`kept VPC ${vpcId}`);
  } else {
    await deleteVpcBestEffort(client, vpcId);
  }
}

async function cleanupAndExit(code: number): Promise<void> {
  await cleanupResources();
  process.exit(code);
}

function installSignalCleanup(): void {
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
}

function onSigint(): void {
  void cleanupAndExit(130);
}

function onSigterm(): void {
  void cleanupAndExit(143);
}

function assertMarker(output: string, marker: string, step: string): void {
  if (!output.includes(marker)) {
    throw new Error(`${step} did not report ${marker}`);
  }
}

function privateIpsForCidr24(input: string): [string, string] {
  const match = input.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.0\/24$/);
  if (!match) {
    throw new Error("FREESTYLE_VPC_CIDR must be a /24 like 192.168.250.0/24 for this demo");
  }
  return [`${match[1]}.10`, `${match[1]}.11`];
}

function networkProbeScript(expectedIp: string): string {
  return bashScript(`
set -u
echo "hostname=$(hostname)"
echo "ip addr:"
ip -4 addr show 2>&1 || true
echo "routes:"
ip route show 2>&1 || true
if ip -4 addr show | grep -F ${shellSingleQuote(expectedIp)} >/dev/null; then
  echo PRIVATE_IP_PRESENT
else
  echo PRIVATE_IP_MISSING
fi
`);
}

function installToolsScript(): string {
  return bashScript(`
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -y >/tmp/freestyle-vpc-apt-update.log 2>&1
apt-get install -y curl iproute2 iputils-ping python3 >/tmp/freestyle-vpc-apt-install.log 2>&1
echo INSTALL_TOOLS_OK
`);
}

function pingPeerScript(peerIp: string): string {
  return bashScript(`
set -u
if ! command -v ping >/dev/null 2>&1; then
  echo PING_MISSING
  exit 0
fi
if ping -c 3 -W 2 ${shellSingleQuote(peerIp)}; then
  echo PING_OK
else
  echo PING_FAILED
fi
exit 0
`);
}

function httpServerScript(label: string): string {
  return bashScript(`
set -u
pkill -f '[p]ython3 -m http.server 18081' >/dev/null 2>&1 || true
mkdir -p /tmp/freestyle-vpc-peer
printf 'hello-from-${label}\\n' > /tmp/freestyle-vpc-peer/index.html
python3 - <<'PY'
import os

pid = os.fork()
if pid == 0:
    os.setsid()
    os.chdir("/tmp/freestyle-vpc-peer")
    with open("/dev/null", "rb", buffering=0) as stdin, open("/tmp/freestyle-vpc-peer/http.log", "ab", buffering=0) as out:
        os.dup2(stdin.fileno(), 0)
        os.dup2(out.fileno(), 1)
        os.dup2(out.fileno(), 2)
        os.execlp("python3", "python3", "-m", "http.server", "18081", "--bind", "0.0.0.0")
print(f"HTTP_SERVER_PID={pid}")
PY
for i in $(seq 1 80); do
  if curl -fsS http://127.0.0.1:18081/ >/tmp/freestyle-vpc-peer/local.out 2>/tmp/freestyle-vpc-peer/local.err; then
    echo HTTP_SERVER_OK
    cat /tmp/freestyle-vpc-peer/local.out
    exit 0
  fi
  sleep 0.25
done
echo HTTP_SERVER_FAILED
cat /tmp/freestyle-vpc-peer/http.log /tmp/freestyle-vpc-peer/local.err 2>/dev/null || true
exit 0
`);
}

function curlPeerScript(peerIp: string): string {
  return bashScript(`
set -u
for i in $(seq 1 80); do
  if curl -fsS --max-time 3 http://${shellSingleQuote(peerIp).slice(1, -1)}:18081/; then
    echo PEER_CURL_OK
    exit 0
  fi
  sleep 0.5
done
echo PEER_CURL_FAILED
exit 0
`);
}
