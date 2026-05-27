# Findings

Date: May 26, 2026

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

## Freestyle Built-In VPC Retest

Docs:

- VPCs: `https://www.freestyle.sh/docs/vms/network/vpcs`
- VPNs: `https://www.freestyle.sh/docs/vms/network/vpns`

Command:

```bash
npm run vpc
```

Result:

```text
vpc_id=vpc_f3b3da67cc37446692b056c8feaf8d5c
vpc_cidr=10.95.231.0/24
worker_a_private_ip=10.95.231.10
worker_b_private_ip=10.95.231.11
worker_a_domains=0
worker_b_domains=0
PRIVATE_IP_PRESENT
PING_OK
PEER_CURL_OK
summary:
vpc_private_ip_present=yes
vpc_ping=yes
vpc_tcp=yes
```

Notes:

- This path uses Freestyle's built-in VPC API only. It does not use Headscale, Tailscale, DERP, kernel TUN, or arbitrary UDP.
- VMs are created with `nics: [{ default: true, vpc, mode: "routed", ipv4 }]`.
- Each VM gets a routed private VLAN interface such as `eth0.1849@eth0`.
- The VPC route appears inside the VM as `10.95.231.0/24 dev eth0.1849`.
- VM-to-VM ICMP works with sub-millisecond to low-millisecond latency in this test.
- VM-to-VM TCP works both directions:
  - worker A curls `http://10.95.231.11:18081/` and receives `hello-from-b`
  - worker B curls `http://10.95.231.10:18081/` and receives `hello-from-a`
- No public VM domains are returned when the VMs are created with `ports: []`.
- The script now defaults to a random private `/24` because the current API does not let this repro delete old VPCs. Reusing the original fixed `192.168.250.0/24` after a previous VPC remained caused both VM creates to fail with backend `500`.

Current rough edges:

- `vms.create({ nics, aptDeps })` returned a backend `500`. Creating the VMs with `nics` first, then installing packages inside the VM with `apt-get`, worked.
- `DELETE /v1/vpcs/:vpcId` returned `404`; `GET /v1/vpcs` returned `405`. The current SDK exposes VPC create and WireGuard methods but no VPC delete/list methods.

## Freestyle Built-In VPC VPN Retest

Command:

```bash
FREESTYLE_VPN_PRINT_ONLY=1 npm run vpc:vpn
```

Result:

```text
vpc_id=vpc_e8bbb70de42c41b5b678e25289a974e6
vpc_cidr=10.89.151.0/24
vm_private_ip=10.89.151.10
HTTP_SERVER_OK
hello-from-vpc-vpn
vpn_session=yw6U7eFY
wireguard_interface=fsvpcnkaxr9
client_tunnel_ip=100.97.151.154
allowed_ips=10.89.151.0/24
vpn_config_written=yes
```

Notes:

- `vpc.wireguard.createEphemeral()` successfully returns a standard WireGuard client config and session ID.
- The demo writes the config to an exclusive file with `0600` permissions inside a unique temp directory, uses a short basename for `wg-quick`'s interface-name limit, registers signal cleanup before remote allocation, closes the Freestyle ephemeral session on exit, and removes the config file.
- This machine cannot bring the tunnel up non-interactively right now: `wg-quick` is not installed and `sudo -n true` fails. On a machine with `wireguard-tools` and noninteractive sudo, run:

```bash
FREESTYLE_VPN_UP=1 npm run vpc:vpn
```

## Questions For Freestyle

1. Is there a VPC delete/lifecycle API, or are VPCs expected to be persistent account resources for now?
2. Should `vms.create({ nics, aptDeps })` work, or should cmux create VPC-attached VMs first and install packages afterward?
3. Is `vpc.wireguard.createEphemeral()` the intended cmux desktop-to-VPC integration point while a workspace is open?
4. Is the CONNMARK/iptables warning expected or worth fixing for Tailscale health?
5. Is internal port `8080` intentionally occupied on base VMs?
