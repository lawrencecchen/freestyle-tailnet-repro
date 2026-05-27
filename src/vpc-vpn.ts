import { spawn } from "node:child_process";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
} from "./lib.js";

requireFreestyleApiKey();

const runId = `fs-vpn-${Date.now().toString(36)}`;
const cidr = process.env.FREESTYLE_VPC_CIDR ?? randomPrivateCidr24();
const vmIp = privateIpForCidr24(cidr);
const client = freestyleClient();
const vmIds: string[] = [];
let vpcId: string | null = null;
let closeConnection: (() => Promise<void>) | null = null;
let configPath: string | null = null;
let configDir: string | null = null;
let wireguardUp = false;
let cleanupStarted = false;

installSignalCleanup();

try {
  console.log("== create VPC and VM ==");
  const createdVpc = await client.vpc.create({
    name: runId,
    cidr,
  });
  vpcId = createdVpc.vpcId;
  const vpc = createdVpc.vpc;
  console.log(`vpc_id=${vpcId}`);
  console.log(`vpc_cidr=${cidr}`);

  const created = await createVm(client, {
    idleTimeoutSeconds: 300,
    persistence: { type: "ephemeral" },
    ports: [],
    nics: [{ default: true, vpc: vpcId, mode: "routed", ipv4: vmIp }],
  });
  vmIds.push(created.vmId);
  console.log(`vm=${created.vmId}`);
  console.log(`vm_private_ip=${vmIp}`);
  console.log(`vm_domains=${created.domains.length}`);

  console.log("\n== install probe tools ==");
  const install = await execText(created.vm, installToolsScript(), 180_000);
  console.log(redact(install));
  assertMarker(install, "INSTALL_TOOLS_OK", "install probe tools");

  console.log("\n== start private HTTP service ==");
  const server = await execText(created.vm, httpServerScript(), 30_000);
  console.log(redact(server));

  console.log("\n== create ephemeral WireGuard VPN session ==");
  const connection = await vpc.wireguard.createEphemeral();
  closeConnection = () => connection.close();
  const interfaceName = `fsvpc${Date.now().toString(36).slice(-6)}`;
  configDir = await mkdtemp(join(tmpdir(), "freestyle-vpc-vpn-"));
  configPath = join(configDir, `${interfaceName}.conf`);
  const configFile = await open(configPath, "wx", 0o600);
  try {
    await configFile.writeFile(connection.clientConfig);
  } finally {
    await configFile.close();
  }
  console.log(`vpn_session=${connection.sessionId}`);
  console.log(`wireguard_interface=${interfaceName}`);
  console.log(`wireguard_config=${configPath}`);
  console.log(`client_tunnel_ip=${connection.clientTunnelIp}`);
  console.log(`allowed_ips=${connection.clientAllowedIps.join(",")}`);

  if (process.env.FREESTYLE_VPN_UP === "1") {
    console.log("\n== bring up WireGuard and curl from this computer ==");
    wireguardUp = true;
    await run("sudo", ["-n", "wg-quick", "up", configPath]);
    await run("curl", ["-fsS", `http://${vmIp}:18081/`]);
    console.log("LOCAL_VPN_CURL_OK");
    await cleanup(0);
  } else if (process.env.FREESTYLE_VPN_PRINT_ONLY === "1") {
    console.log("\nsummary:");
    console.log(`vpc_id=${vpcId}`);
    console.log(`vpn_session=${connection.sessionId}`);
    console.log("vpn_config_written=yes");
    await cleanup(0);
  } else {
    console.log("\nRun these in another terminal while this process stays alive:");
    console.log(`sudo wg-quick up ${configPath}`);
    console.log(`curl -fsS http://${vmIp}:18081/`);
    console.log(`sudo wg-quick down ${configPath}`);
    console.log("\nPress Ctrl-C here to close the Freestyle VPN session and delete the VM.");
    await new Promise(() => {});
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  await cleanup(1);
}

async function cleanup(code: number): Promise<never> {
  if (cleanupStarted) {
    return new Promise(() => {});
  }
  cleanupStarted = true;
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
  if (wireguardUp && configPath) {
    await run("sudo", ["-n", "wg-quick", "down", configPath]).catch(() => undefined);
    wireguardUp = false;
  }
  if (closeConnection) {
    await closeConnection().catch(() => undefined);
    closeConnection = null;
  }
  if (configPath) {
    await rm(configPath, { force: true }).catch(() => undefined);
    configPath = null;
  }
  if (configDir) {
    await rm(configDir, { force: true, recursive: true }).catch(() => undefined);
    configDir = null;
  }
  await deleteVms(client, vmIds);
  if (process.env.FREESTYLE_KEEP_VPC === "1") {
    console.log(`kept VPC ${vpcId}`);
  } else {
    await deleteVpcBestEffort(client, vpcId);
  }
  process.exit(code);
}

function installSignalCleanup(): void {
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
}

function onSigint(): void {
  void cleanup(130);
}

function onSigterm(): void {
  void cleanup(143);
}

function privateIpForCidr24(input: string): string {
  const match = input.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.0\/24$/);
  if (!match) {
    throw new Error("FREESTYLE_VPC_CIDR must be a /24 like 192.168.251.0/24 for this demo");
  }
  return `${match[1]}.10`;
}

function httpServerScript(): string {
  return bashScript(`
set -u
pkill -f '[p]ython3 -m http.server 18081' >/dev/null 2>&1 || true
mkdir -p /tmp/freestyle-vpc-vpn
printf 'hello-from-vpc-vpn\\n' > /tmp/freestyle-vpc-vpn/index.html
python3 - <<'PY'
import os

pid = os.fork()
if pid == 0:
    os.setsid()
    os.chdir("/tmp/freestyle-vpc-vpn")
    with open("/dev/null", "rb", buffering=0) as stdin, open("/tmp/freestyle-vpc-vpn/http.log", "ab", buffering=0) as out:
        os.dup2(stdin.fileno(), 0)
        os.dup2(out.fileno(), 1)
        os.dup2(out.fileno(), 2)
        os.execlp("python3", "python3", "-m", "http.server", "18081", "--bind", "0.0.0.0")
print(f"HTTP_SERVER_PID={pid}")
PY
for i in $(seq 1 80); do
  if curl -fsS http://127.0.0.1:18081/ >/tmp/freestyle-vpc-vpn/local.out 2>/tmp/freestyle-vpc-vpn/local.err; then
    echo HTTP_SERVER_OK
    cat /tmp/freestyle-vpc-vpn/local.out
    exit 0
  fi
  sleep 0.25
done
echo HTTP_SERVER_FAILED
cat /tmp/freestyle-vpc-vpn/http.log /tmp/freestyle-vpc-vpn/local.err 2>/dev/null || true
exit 0
`);
}

function installToolsScript(): string {
  return bashScript(`
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -y >/tmp/freestyle-vpc-vpn-apt-update.log 2>&1
apt-get install -y curl python3 >/tmp/freestyle-vpc-vpn-apt-install.log 2>&1
echo INSTALL_TOOLS_OK
`);
}

function assertMarker(output: string, marker: string, step: string): void {
  if (!output.includes(marker)) {
    throw new Error(`${step} did not report ${marker}`);
  }
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} failed with ${code}`));
      }
    });
  });
}
