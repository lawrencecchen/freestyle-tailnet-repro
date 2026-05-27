import {
  createVm,
  deleteVms,
  execText,
  freestyleClient,
  redact,
  requireFreestyleApiKey,
} from "./lib.js";

requireFreestyleApiKey();

const client = freestyleClient();
const vmIds: string[] = [];
let cleanupStarted = false;

installSignalCleanup();

try {
  const created = await createVm(client, {
    aptDeps: ["bash", "ca-certificates", "curl", "iproute2", "kmod", "libcap2-bin", "python3"],
    idleTimeoutSeconds: 300,
  });
  vmIds.push(created.vmId);
  console.log(`vm=${created.vmId}`);

  const result = await execText(created.vm, tunProbeScript(), 180_000);
  console.log(redact(result));

  console.log("\nsummary:");
  console.log(`kernel_tun=${/KERNEL_TUN_OK/.test(result) ? "yes" : "no"}`);
} finally {
  await cleanupResources();
}

async function cleanupResources(): Promise<void> {
  if (cleanupStarted) return;
  cleanupStarted = true;
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
  await deleteVms(client, vmIds);
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

function tunProbeScript(): string {
  return String.raw`
set -u
echo "id=$(id)"
echo "kernel=$(uname -a)"
echo "mounts:"
findmnt -T /dev -o TARGET,FSTYPE,OPTIONS 2>/dev/null || true
findmnt -T /sys -o TARGET,FSTYPE,OPTIONS 2>/dev/null || true
echo "process status:"
grep -E '^(Cap|Seccomp|NoNewPrivs)' /proc/self/status || true
echo "capabilities:"
command -v capsh >/dev/null 2>&1 && capsh --print | sed -n '1,12p' || true
echo "kernel config TUN entries:"
if [ -r /proc/config.gz ]; then
  zgrep -E 'CONFIG_(TUN|NET_UDP_TUNNEL|WIREGUARD)=' /proc/config.gz || true
fi
if [ -r "/boot/config-$(uname -r)" ]; then
  grep -E 'CONFIG_(TUN|NET_UDP_TUNNEL|WIREGUARD)=' "/boot/config-$(uname -r)" || true
fi
if [ -r "/lib/modules/$(uname -r)/build/.config" ]; then
  grep -E 'CONFIG_(TUN|NET_UDP_TUNNEL|WIREGUARD)=' "/lib/modules/$(uname -r)/build/.config" || true
fi
echo "module tree:"
ls -ld "/lib/modules/$(uname -r)" 2>&1 || true
find "/lib/modules/$(uname -r)" -iname '*tun*' -o -iname '*wireguard*' 2>/dev/null | sort | head -40 || true
echo "registered char devices:"
grep -E '(^ *10 misc$|tun)' /proc/devices /proc/misc 2>/dev/null || true
echo "/proc/misc tun entry:"
grep -w tun /proc/misc || true
echo "existing tun paths:"
ls -l /dev/net/tun /sys/module/tun /sys/dev/char/10:200 2>/dev/null || true
echo "modprobe tun:"
modprobe tun 2>&1 || true
mkdir -p /dev/net
if [ ! -c /dev/net/tun ]; then
  mknod /dev/net/tun c 10 200 2>/tmp/mknod.err || true
fi
chmod 666 /dev/net/tun 2>/tmp/chmod.err || true
ls -l /dev/net/tun 2>/dev/null || true
echo "dmesg after mknod/modprobe:"
dmesg 2>/dev/null | tail -40 || true
echo "ip tuntap:"
ip tuntap add dev cmuxprobe mode tun 2>&1 || true
python3 - <<'PY'
import fcntl
import os
import struct
import sys

TUNSETIFF = 0x400454ca
IFF_TUN = 0x0001
IFF_NO_PI = 0x1000

try:
    fd = os.open("/dev/net/tun", os.O_RDWR)
    ifr = struct.pack("16sH", b"cmuxprobe%d", IFF_TUN | IFF_NO_PI)
    res = fcntl.ioctl(fd, TUNSETIFF, ifr)
    name = res[:16].split(b"\x00", 1)[0].decode()
    print(f"python_tun_open_ok={name}")
    os.close(fd)
    print("KERNEL_TUN_OK")
except Exception as exc:
    print(f"python_tun_open_failed={type(exc).__name__}:{exc}")
    print("KERNEL_TUN_FAILED")
    sys.exit(0)
PY
`;
}
