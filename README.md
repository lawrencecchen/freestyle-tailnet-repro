# Freestyle tailnet repro

This repo is a minimal reproduction for Freestyle VM networking behavior with Tailscale, Headscale, and Freestyle's built-in VPC/VPN APIs.

The original issue: Freestyle VMs could run `tailscaled` in userspace mode, and Headscale could run on a Freestyle VM, but normal kernel TUN networking was not available. That prevented a standard `tailscale0` interface and normal VM-to-VM service networking.

Observed on May 22, 2026 before Freestyle's kernel fix:

- `/dev/net/tun` is absent by default.
- Creating `/dev/net/tun` with `mknod` succeeds, but `TUNSETIFF` fails with `OSError: [Errno 19] No such device`.
- `modprobe tun` does not make TUN usable.
- `tailscaled --tun=userspace-networking` starts.
- A Headscale control server can run on a Freestyle control VM and be reached at `https://<vmId>.vm.freestyle.sh`.
- On a plain Freestyle VM, port `8080` may already be occupied, so this repro maps external HTTPS `443` to internal `18080`.
- Two worker VMs can join that Headscale server with userspace Tailscale.
- `tailscale ping` succeeds through DERP.
- Direct peer connection is not established.

Retested on May 23, 2026 after Freestyle's kernel fix:

- `npm run tun` now reports `kernel_tun=yes`.
- `npm run headscale:kernel` creates real `tailscale0` interfaces on two worker VMs.
- Plain HTTP over the 100.64.x tailnet IPs works both directions.
- Direct peer connection still does not establish, expected until arbitrary UDP support lands.

Retested on May 26, 2026 with Freestyle's built-in VPC API:

- `npm run vpc` creates one VPC and two VMs attached with routed private NICs.
- The VMs get private IPs on a random VPC `/24`, unless `FREESTYLE_VPC_CIDR` is set.
- Ping and plain HTTP work both directions over the private VPC IPs.
- No Headscale, Tailscale, kernel TUN, DERP, or arbitrary UDP is involved in this path.
- `npm run vpc:vpn` creates an ephemeral WireGuard session and writes the generated client config for desktop-to-VPC access.

## Run

```bash
npm_config_min_release_age=0 npm install
export FREESTYLE_API_KEY=...
npm run tun
npm run headscale
npm run headscale:kernel
npm run vpc
FREESTYLE_VPN_PRINT_ONLY=1 npm run vpc:vpn
```

`npm_config_min_release_age=0` is only needed if your npm environment blocks packages published in the last few days. This repro uses `freestyle@0.1.55` for the new VPC/WireGuard API surface.

The VM scripts create disposable Freestyle VMs and delete them in `finally` blocks. VPC CIDRs are randomized by default because current VPC cleanup attempts `DELETE /v1/vpcs/:id`, but the endpoint returns `404`, so VPC deletion appears to be missing or undocumented.

## Current question for Freestyle

The built-in VPC path appears to satisfy cmux's VM-to-VM private TCP use case. Remaining questions:

1. Is there a VPC delete/lifecycle API?
2. Should `vms.create({ nics, aptDeps })` work, or should callers create the VM first and install packages afterward?
3. For desktop-to-VPC access, is `vpc.wireguard.createEphemeral()` the intended cmux integration point while a workspace is open?
