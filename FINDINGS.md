# Findings

Date: May 22, 2026

## Kernel TUN

Command:

```bash
npm run tun
```

Result:

```text
kernel=Linux ... 6.1.0-8-freestyle ...
Bounding set = ... cap_net_admin ... cap_sys_module ... cap_mknod ...
modprobe: FATAL: Module tun not found in directory /lib/modules/6.1.0-8-freestyle
crw-rw-rw- 1 root root 10, 200 ... /dev/net/tun
ip tuntap:
open: No such device
python_tun_open_failed=OSError:[Errno 19] No such device: '/dev/net/tun'
KERNEL_TUN_FAILED
```

Interpretation: the process has the relevant capabilities, and the device node can be created, but the kernel does not expose a usable TUN device.

## Managed Tailscale

Extra local experiment, not required by the repo:

- `tailscaled --tun=userspace-networking` starts in Freestyle VMs.
- Tagged nodes did not see each other in our existing tailnet ACL.
- Untagged preauthorized nodes did see each other.
- `tailscale ping` succeeded through DERP.
- Direct connection was not established.
- `tailscale serve --http=18080 text:hello-from-a` was reachable from another Freestyle VM by MagicDNS name through the userspace SOCKS proxy.
- The same service by 100.x IP returned 404, likely because Tailscale Serve dispatches by host name.

## Headscale On Freestyle

Command:

```bash
npm run headscale
```

Result:

```text
HEADSCALE_LOCAL_HEALTH_OK
external control VM health: ok status=200 body={"status":"pass"}
HEADSCALE_UP_OK
TAILSCALE_IP=100.64.0.1
HEADSCALE_UP_OK
TAILSCALE_IP=100.64.0.2
pong from ... via DERP(sfo)
direct connection not established
summary:
headscale_health=yes
headscale_join=yes
headscale_ping=yes
direct_peer_connection=no
```

Notes:

- Headscale v0.28.0 runs on a Freestyle VM.
- `https://<vmId>.vm.freestyle.sh` works as the Headscale `server_url` when Freestyle maps external `443` to the internal Headscale port.
- On a plain Freestyle VM, internal port `8080` was already in use, so the repro uses internal `18080`.
- Worker VMs join the Headscale server with Tailscale userspace networking.
- Peer reachability works via DERP, but no direct peer connection is established.

## Questions For Freestyle

1. Can Freestyle expose kernel TUN support for VM workloads?
2. If not, is userspace Tailscale plus Tailscale Serve/app-level relay the recommended path?
3. Is internal port `8080` intentionally occupied on base VMs?
4. Is there a supported way to expose UDP, especially for self-hosted DERP/STUN?
