import {
  bashScript,
  deleteVms,
  execText,
  freestyleClient,
  redact,
  requireFreestyleApiKey,
  shellSingleQuote,
} from "./lib.js";

requireFreestyleApiKey();

const runId = `fs-hs-${Date.now().toString(36)}`;
const tailnetMode = process.env.TAILSCALE_MODE === "kernel" ? "kernel" : "userspace";
const client = freestyleClient();
const vmIds: string[] = [];

try {
  const control = await client.vms.create({
    aptDeps: ["bash", "ca-certificates", "curl", "iproute2", "jq"],
    ports: [{ port: 443, targetPort: 18080 }],
    idleTimeoutSeconds: 600,
  });
  vmIds.push(control.vm.vmId);
  const controlUrl = `https://${control.vm.vmId}.vm.freestyle.sh`;
  console.log(`control_vm=${control.vm.vmId}`);
  console.log(`control_url=${controlUrl}`);

  console.log("\n== start headscale control VM ==");
  const setup = await execText(control.vm, setupHeadscaleScript(controlUrl), 240_000);
  console.log(redact(setup));

  console.log("\n== external control VM health ==");
  const health = await waitForHeadscale(controlUrl);
  console.log(health);

  console.log("\n== create headscale preauth key ==");
  const keyOut = await execText(control.vm, createPreauthKeyScript(), 60_000);
  console.log(redact(keyOut));
  const authKey = extractHeadscaleKey(keyOut);
  if (!authKey) throw new Error("failed to extract Headscale preauth key");

  const [a, b] = await Promise.all([
    client.vms.create({
      aptDeps: ["bash", "ca-certificates", "curl", "iproute2", "python3"],
      idleTimeoutSeconds: 300,
    }),
    client.vms.create({
      aptDeps: ["bash", "ca-certificates", "curl", "iproute2", "python3"],
      idleTimeoutSeconds: 300,
    }),
  ]);
  vmIds.push(a.vm.vmId, b.vm.vmId);
  console.log(`worker_a=${a.vm.vmId}`);
  console.log(`worker_b=${b.vm.vmId}`);

  console.log(`\n== workers join headscale using tailscaled ${tailnetMode} networking ==`);
  const [joinA, joinB] = await Promise.all([
    execText(a.vm, joinHeadscaleScript(controlUrl, authKey, `${runId}-a`, tailnetMode), 180_000),
    execText(b.vm, joinHeadscaleScript(controlUrl, authKey, `${runId}-b`, tailnetMode), 180_000),
  ]);
  console.log("[a]\n" + redact(joinA));
  console.log("[b]\n" + redact(joinB));

  const ipA = extractTailscaleIp(joinA);
  const ipB = extractTailscaleIp(joinB);
  if (!ipA || !ipB) throw new Error(`missing Tailscale IPs: a=${ipA ?? "-"} b=${ipB ?? "-"}`);

  console.log("\n== headscale nodes ==");
  console.log(redact(await execText(control.vm, "headscale -c /etc/headscale/config.yaml nodes list", 30_000)));

  console.log("\n== worker-to-worker tailscale ping ==");
  const [pingAtoB, pingBtoA] = await Promise.all([
    execText(a.vm, tailscalePingScript(ipB), 30_000),
    execText(b.vm, tailscalePingScript(ipA), 30_000),
  ]);
  console.log("[a -> b]\n" + redact(pingAtoB));
  console.log("[b -> a]\n" + redact(pingBtoA));

  let tcpAtoB = "";
  let tcpBtoA = "";
  if (tailnetMode === "kernel") {
    console.log("\n== worker-to-worker TCP over tailnet IP ==");
    const [serverA, serverB] = await Promise.all([
      execText(a.vm, httpServerScript("a"), 30_000),
      execText(b.vm, httpServerScript("b"), 30_000),
    ]);
    console.log("[server a]\n" + redact(serverA));
    console.log("[server b]\n" + redact(serverB));
    [tcpAtoB, tcpBtoA] = await Promise.all([
      execText(a.vm, curlPeerScript(ipB), 60_000),
      execText(b.vm, curlPeerScript(ipA), 60_000),
    ]);
    console.log("[a -> b http]\n" + redact(tcpAtoB));
    console.log("[b -> a http]\n" + redact(tcpBtoA));
  }

  console.log("\nsummary:");
  console.log(`tailnet_mode=${tailnetMode}`);
  console.log(`headscale_health=${health.includes("ok") ? "yes" : "no"}`);
  console.log(`headscale_join=${/HEADSCALE_UP_OK/.test(joinA) && /HEADSCALE_UP_OK/.test(joinB) ? "yes" : "no"}`);
  console.log(`headscale_ping=${/pong/.test(pingAtoB) && /pong/.test(pingBtoA) ? "yes" : "no"}`);
  console.log(`direct_peer_connection=${/direct connection not established/.test(pingAtoB + pingBtoA) ? "no" : "maybe"}`);
  if (tailnetMode === "kernel") {
    console.log(`tailnet_tcp=${/hello-from-b/.test(tcpAtoB) && /hello-from-a/.test(tcpBtoA) ? "yes" : "no"}`);
  }
} finally {
  await deleteVms(client, vmIds);
}

async function waitForHeadscale(controlUrl: string): Promise<string> {
  for (let i = 0; i < 90; i++) {
    try {
      const response = await fetch(`${controlUrl}/health`, { signal: AbortSignal.timeout(5_000) });
      const body = await response.text();
      if (response.ok && !body.includes("Reloading")) {
        return `ok status=${response.status} body=${body.slice(0, 120)}`;
      }
    } catch {
      // Retry until the Freestyle proxy and Headscale process are both ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return "failed timeout";
}

function setupHeadscaleScript(controlUrl: string): string {
  return bashScript(`
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -y >/dev/null
apt-get install -y curl ca-certificates iproute2 jq >/dev/null
curl -fsSL -o /tmp/headscale.deb https://github.com/juanfont/headscale/releases/download/v0.28.0/headscale_0.28.0_linux_amd64.deb
apt-get install -y /tmp/headscale.deb >/dev/null
mkdir -p /etc/headscale /var/lib/headscale
cat >/etc/headscale/config.yaml <<'YAML'
server_url: ${controlUrl}
listen_addr: 0.0.0.0:18080
metrics_listen_addr: 127.0.0.1:9090
grpc_listen_addr: 127.0.0.1:50443
grpc_allow_insecure: true
noise:
  private_key_path: /var/lib/headscale/noise_private.key
prefixes:
  v4: 100.64.0.0/10
  v6: fd7a:115c:a1e0::/48
  allocation: sequential
derp:
  server:
    enabled: false
    region_id: 999
    region_code: headscale
    region_name: Headscale Embedded DERP
    verify_clients: true
    stun_listen_addr: 0.0.0.0:3478
    private_key_path: /var/lib/headscale/derp_server_private.key
    automatically_add_embedded_derp_region: true
  urls:
    - https://controlplane.tailscale.com/derpmap/default
  paths: []
  auto_update_enabled: true
  update_frequency: 3h
database:
  type: sqlite
  sqlite:
    path: /var/lib/headscale/db.sqlite
    write_ahead_log: true
log:
  format: text
  level: info
policy:
  mode: file
  path: /etc/headscale/policy.hujson
dns:
  magic_dns: false
  override_local_dns: false
  base_domain: freestyle-repro.test
YAML
cat >/etc/headscale/policy.hujson <<'HUJSON'
{
  "groups": {},
  "tagOwners": {},
  "acls": [
    {
      "action": "accept",
      "src": ["*"],
      "dst": ["*:*"]
    }
  ]
}
HUJSON
headscale -c /etc/headscale/config.yaml configtest
pkill headscale >/dev/null 2>&1 || true
nohup headscale -c /etc/headscale/config.yaml serve >/tmp/headscale.log 2>&1 &
for i in $(seq 1 80); do
  if curl -fsS http://127.0.0.1:18080/health >/tmp/headscale-health.txt 2>/tmp/headscale-health.err; then
    echo HEADSCALE_LOCAL_HEALTH_OK
    cat /tmp/headscale-health.txt
    headscale version
    exit 0
  fi
  sleep 0.5
done
echo HEADSCALE_LOCAL_HEALTH_FAILED
cat /tmp/headscale.log /tmp/headscale-health.err 2>/dev/null || true
exit 0
`);
}

function createPreauthKeyScript(): string {
  return bashScript(String.raw`
set -euo pipefail
headscale -c /etc/headscale/config.yaml users create cmux >/tmp/headscale-user.log 2>&1 || true
headscale -c /etc/headscale/config.yaml users list
headscale -c /etc/headscale/config.yaml preauthkeys create --user 1 --reusable --ephemeral --expiration 1h | tee /tmp/headscale-key.out
`);
}

function joinHeadscaleScript(
  controlUrl: string,
  authKey: string,
  hostname: string,
  mode: "kernel" | "userspace",
): string {
  const daemonArgs =
    mode === "userspace"
      ? "--tun=userspace-networking --socks5-server=127.0.0.1:1055 --outbound-http-proxy-listen=127.0.0.1:1055"
      : "";
  const readinessCheck =
    mode === "userspace"
      ? "ss -ltn | grep -q ':1055 '"
      : "test -S /tmp/freestyle-repro-ts/tailscaled.sock";
  const postJoinDiagnostics =
    mode === "kernel"
      ? String.raw`
ip addr show tailscale0 2>&1 || true
ip route show table all | grep -E 'tailscale0|100\\.64\\.' || true
`
      : "";
  return bashScript(`
set -u
if ! command -v tailscaled >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh >/tmp/tailscale-install.log 2>&1
fi
pkill tailscaled >/dev/null 2>&1 || true
pgrep tailscaled >/dev/null 2>&1 && pkill -9 tailscaled >/dev/null 2>&1 || true
rm -rf /tmp/freestyle-repro-ts
mkdir -p /tmp/freestyle-repro-ts
tailscaled --state=/tmp/freestyle-repro-ts/state --socket=/tmp/freestyle-repro-ts/tailscaled.sock ${daemonArgs} >/tmp/freestyle-repro-ts/tailscaled.log 2>&1 &
for i in $(seq 1 120); do
  if ${readinessCheck}; then
    break
  fi
  sleep 0.25
done
tailscale --socket=/tmp/freestyle-repro-ts/tailscaled.sock up --login-server=${shellSingleQuote(controlUrl)} --auth-key=${shellSingleQuote(authKey)} --hostname=${shellSingleQuote(hostname)} --accept-dns=true --reset >/tmp/freestyle-repro-ts/up.log 2>&1
up_status=$?
cat /tmp/freestyle-repro-ts/up.log
if [ "$up_status" -ne 0 ]; then
  echo HEADSCALE_UP_FAILED
  cat /tmp/freestyle-repro-ts/tailscaled.log
  exit 0
fi
echo HEADSCALE_UP_OK
tailscale --socket=/tmp/freestyle-repro-ts/tailscaled.sock ip -4 | head -1 | sed 's/^/TAILSCALE_IP=/'
tailscale --socket=/tmp/freestyle-repro-ts/tailscaled.sock status
${postJoinDiagnostics}
`);
}

function tailscalePingScript(peerIp: string): string {
  return bashScript(`
set -u
timeout 20s tailscale --socket=/tmp/freestyle-repro-ts/tailscaled.sock ping --timeout=10s ${shellSingleQuote(peerIp)}
echo PING_EXIT=$?
exit 0
`);
}

function extractHeadscaleKey(text: string): string | null {
  return text.match(/\b(hskey-[A-Za-z0-9_-]+)\b/)?.[1] ?? null;
}

function extractTailscaleIp(text: string): string | null {
  return text.match(/TAILSCALE_IP=([0-9.]+)/)?.[1] ?? null;
}

function httpServerScript(label: string): string {
  return bashScript(`
set -u
pkill -f '[p]ython3 -m http.server 18081' >/dev/null 2>&1 || true
mkdir -p /tmp/freestyle-peer
printf 'hello-from-${label}\\n' > /tmp/freestyle-peer/index.html
python3 - <<'PY'
import os

pid = os.fork()
if pid == 0:
    os.setsid()
    os.chdir("/tmp/freestyle-peer")
    with open("/dev/null", "rb", buffering=0) as stdin, open("/tmp/freestyle-peer/http.log", "ab", buffering=0) as out:
        os.dup2(stdin.fileno(), 0)
        os.dup2(out.fileno(), 1)
        os.dup2(out.fileno(), 2)
        os.execlp("python3", "python3", "-m", "http.server", "18081", "--bind", "0.0.0.0")
print(f"HTTP_SERVER_PID={pid}")
PY
for i in $(seq 1 80); do
  if curl -fsS http://127.0.0.1:18081/ >/tmp/freestyle-peer/local.out 2>/tmp/freestyle-peer/local.err; then
    echo HTTP_SERVER_OK
    cat /tmp/freestyle-peer/local.out
    exit 0
  fi
  sleep 0.25
done
echo HTTP_SERVER_FAILED
cat /tmp/freestyle-peer/http.log /tmp/freestyle-peer/local.err 2>/dev/null || true
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
