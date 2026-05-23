# Freestyle tailnet repro

This repo is a minimal reproduction for Freestyle VM networking behavior with Tailscale and Headscale.

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

## Run

```bash
npm install
export FREESTYLE_API_KEY=...
npm run tun
npm run headscale
npm run headscale:kernel
```

Both scripts create disposable Freestyle VMs and delete them in `finally` blocks.

## Current question for Freestyle

Is DERP-relayed TCP over kernel TUN a supported temporary path until arbitrary UDP or the VPC API ships?
