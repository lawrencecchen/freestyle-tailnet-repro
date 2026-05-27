import { randomBytes } from "node:crypto";

import { Freestyle } from "freestyle";

export type VmHandle = Awaited<ReturnType<InstanceType<typeof Freestyle>["vms"]["create"]>>["vm"];
export type VmCreateResult = Awaited<ReturnType<InstanceType<typeof Freestyle>["vms"]["create"]>> & {
  vmId: string;
};

export type VmCreateOptionsCompat = NonNullable<Parameters<InstanceType<typeof Freestyle>["vms"]["create"]>[0]> & {
  aptDeps?: string[];
  ports?: { port: number; targetPort: number }[];
  nics?: {
    default?: boolean;
    vpc: string;
    mode: "routed";
    ipv4: string;
  }[];
  persistence?: { type: "ephemeral" | "sticky" | "persistent"; priority?: number };
};

type ExecResult = {
  statusCode?: number;
  exitCode?: number;
  stdout?: string | null;
  stderr?: string | null;
};

export function requireFreestyleApiKey(): void {
  if (!process.env.FREESTYLE_API_KEY) {
    throw new Error("FREESTYLE_API_KEY is required");
  }
}

export function freestyleClient(): Freestyle {
  return new Freestyle({
    fetch: (input, init) =>
      fetch(input as Request, {
        ...(init ?? {}),
        signal: AbortSignal.timeout(15 * 60 * 1000),
      }),
  });
}

export async function createVm(client: Freestyle, options: VmCreateOptionsCompat = {}): Promise<VmCreateResult> {
  const response = await client.fetch("/v1/vms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(options),
  });
  if (!response.ok) {
    throw new Error(`Failed to create VM: ${response.status} ${await response.text()}`);
  }
  const body = await response.json() as { id: string; domains?: string[] };
  const { vm } = await client.vms.get({ vmId: body.id });
  return {
    ...body,
    vm,
    vmId: body.id,
    domains: body.domains ?? [],
  };
}

export async function execText(vm: VmHandle, command: string, timeoutMs: number): Promise<string> {
  try {
    const result = (await vm.exec({ command, timeoutMs })) as ExecResult | string;
    if (typeof result === "string") return result;
    return [
      result.stdout ? `stdout:\n${result.stdout}` : "",
      result.stderr ? `stderr:\n${result.stderr}` : "",
      result.statusCode === undefined ? "" : `statusCode=${result.statusCode}`,
      result.exitCode === undefined ? "" : `exitCode=${result.exitCode}`,
    ]
      .filter(Boolean)
      .join("\n");
  } catch (err) {
    return `EXEC_THREW ${redact(err instanceof Error ? err.message : String(err))}`;
  }
}

export function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function bashScript(script: string): string {
  return `bash -lc ${shellSingleQuote(script)}`;
}

export function randomPrivateCidr24(): string {
  const bytes = randomBytes(2);
  return `10.${64 + (bytes[0] % 64)}.${bytes[1]}.0/24`;
}

export function redact(value: string): string {
  return value
    .replace(/hskey-[A-Za-z0-9_-]+/g, "hskey-redacted")
    .replace(/tskey-[A-Za-z0-9_-]+/g, "tskey-redacted")
    .replace(/fk_[A-Za-z0-9_-]+/g, "fk_redacted");
}

export async function deleteVms(client: Freestyle, vmIds: string[]): Promise<void> {
  await Promise.all(
    vmIds.map(async (vmId) => {
      try {
        await client.vms.delete({ vmId });
        console.log(`deleted VM ${vmId}`);
      } catch (err) {
        console.log(`failed to delete VM ${vmId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );
}

export async function deleteVpcBestEffort(client: Freestyle, vpcId: string | null): Promise<void> {
  if (!vpcId) return;
  try {
    const response = await client.fetch(`/v1/vpcs/${vpcId}`, { method: "DELETE" });
    if (response.ok) {
      console.log(`deleted VPC ${vpcId}`);
      return;
    }
    if (response.status === 404) {
      console.log(`VPC delete endpoint unavailable for ${vpcId}: status=404`);
      return;
    }
    console.log(`failed to delete VPC ${vpcId}: status=${response.status} body=${await response.text()}`);
  } catch (err) {
    console.log(`failed to delete VPC ${vpcId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
