# Findings

Date: May 23, 2026

## Kernel TUN

Command:

```bash
npm run tun
```

Original result before Freestyle kernel fix:

```text
kernel=Linux ... 6.1.0-8-freestyle ...
devtmpfs is mounted at /dev
Seccomp: 0
NoNewPrivs: 0
Bounding set = ... cap_net_admin ... cap_sys_module ... cap_mknod ...
kernel config TUN entries: no output from /proc/config.gz, /boot/config-$(uname -r), or /lib/modules/.../build/.config
ls: cannot access '/lib/modules/6.1.0-8-freestyle': No such file or directory
registered char devices:
/proc/devices: 10 misc
no tun entry in /proc/misc
modprobe: FATAL: Module tun not found in directory /lib/modules/6.1.0-8-freestyle
crw-rw-rw- 1 root root 10, 200 ... /dev/net/tun
ip tuntap:
open: No such device
python_tun_open_failed=OSError:[Errno 19] No such device: '/dev/net/tun'
KERNEL_TUN_FAILED
```

Retest after Freestyle kernel fix:

```text
kernel=Linux ... 6.1.0-11-freestyle ...
/proc/misc:200 tun
/sys/dev/char/10:200 -> ../../devices/virtual/misc/tun
python_tun_open_ok=cmuxprobe0
KERNEL_TUN_OK
summary:
kernel_tun=yes
```

Interpretation: the kernel TUN issue is fixed on `6.1.0-11-freestyle`.

The original failure looked like the TUN driver was not registered in the running guest kernel:

- If `CONFIG_TUN=y`, `/proc/misc` should normally contain `tun`, and opening a manually-created `/dev/net/tun` char device should not return `ENODEV`.
- If `CONFIG_TUN=m`, then the matching module tree for `6.1.0-8-freestyle` appears missing inside the VM, so `modprobe tun` cannot load it.
- This does not look like a seccomp or Linux capability denial: `Seccomp: 0`, `NoNewPrivs: 0`, and the bounding set includes `cap_net_admin`, `cap_sys_module`, and `cap_mknod`.

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

## Kernel TUN Headscale Retest

Command:

```bash
npm run headscale:kernel
```

Result after Freestyle kernel fix:

```text
tailnet_mode=kernel
headscale_health=yes
headscale_join=yes
headscale_ping=yes
direct_peer_connection=no
tailnet_tcp=yes
```

Notes:

- Both worker VMs join Headscale with normal `tailscaled` kernel networking.
- Both worker VMs get real `tailscale0` interfaces and 100.64.x routes.
- `tailscale ping` still reports `direct connection not established`, expected while arbitrary UDP is unavailable.
- Plain TCP over the tailnet IP works both directions:
  - worker A curls `http://100.64.0.1:18081/` and receives `hello-from-b`
  - worker B curls `http://100.64.0.2:18081/` and receives `hello-from-a`
- Tailscale prints a health warning about CONNMARK/iptables support:

```text
Warning: Extension CONNMARK revision 0 not supported, missing kernel module?
iptables v1.8.11 (nf_tables): unknown option "--nfmask"
```

That warning did not block Headscale join, `tailscale0`, DERP ping, or TCP over tailnet IP in this repro.

## cmux Use Case

What cmux needs first:

- Create multiple Freestyle VMs for the same user/team/workspace group.
- Give those VMs stable private addresses and names.
- Allow VM-to-VM TCP for cmux control/data services, for example cmux daemon RPC, agent coordination, dev servers, browser/proxy helpers, and internal service discovery.
- Keep enrollment hosted by cmux so the end user does not manage Tailscale/Headscale.

What cmux does not need on day one:

- Direct peer-to-peer UDP between VMs, as long as TCP over the private network works through a relay.
- Full arbitrary public UDP exposure.

This means the current kernel TUN fix plus DERP-relayed traffic appears sufficient for a temporary cmux implementation. A future Freestyle VPC API would probably be a cleaner long-term fit if it provides simple VM-to-VM private TCP routing and service discovery without cmux running its own Headscale control VM.

## Questions For Freestyle

1. Is the CONNMARK/iptables warning expected or worth fixing for Tailscale health?
2. Is internal port `8080` intentionally occupied on base VMs?
3. Until arbitrary UDP or the VPC API ships, is DERP-relayed TCP over kernel TUN a supported temporary path?
