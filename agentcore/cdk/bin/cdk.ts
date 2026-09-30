#!/usr/bin/env node
import { AgentCoreStack, type HarnessConfig } from '../lib/cdk-stack';
import { ConfigIO, HarnessSpecSchema, type AwsDeploymentTarget } from '@aws/agentcore-cdk';
import { App, type Environment } from 'aws-cdk-lib';
import * as path from 'path';
import * as fs from 'fs';

function toEnvironment(target: AwsDeploymentTarget): Environment {
  return {
    account: target.account,
    region: target.region,
  };
}

function sanitize(name: string): string {
  return name.replace(/_/g, '-');
}

function toStackName(projectName: string, targetName: string): string {
  return `AgentCore-${sanitize(projectName)}-${sanitize(targetName)}`;
}

type GatewayArns = Record<string, { gatewayArn?: string }> | undefined;

/**
 * Adapt Cedar policy statements to the target's account.
 *
 * The policies in agentcore.json name the original deployment's Gateway by ARN
 * (`resource == AgentCore::Gateway::"arn:…:<account>:gateway/…"`). AgentCore
 * Policy requires a tool-scoped policy to name one specific Gateway, and a
 * Gateway in another account gets a different, generated ARN. So for a target
 * in another account, the ARN is swapped for the ARN of the same-named Gateway
 * in that target's deployed state, looking the name up across every target's
 * deployed Gateways. On the target's first deploy that Gateway
 * doesn't exist yet, so the policy is left out. The policy engine also rejects
 * actions for tools the Gateway doesn't have, so a new account goes:
 * deploy, then gateway-targets/create-targets.sh, then deploy again to add the
 * policies. Until then the engine (ENFORCE, no policies) denies every call.
 * Targets in the ARN's own account get the statements unchanged.
 */
function policiesForTarget<T>(projectSpec: T, targetAccount: string, knownGateways: GatewayArns[], targetGateways: GatewayArns): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const copy = JSON.parse(JSON.stringify(projectSpec)) as any;
  const gatewayArn = /(resource\s*==\s*AgentCore::Gateway::")(arn:aws:bedrock-agentcore:[a-z0-9-]+:(\d{12}):gateway\/[^"]+)"/g;
  const nameForArn = (arn: string) =>
    knownGateways.flatMap(g => Object.entries(g ?? {})).find(([, g]) => g.gatewayArn === arn)?.[0];
  for (const engine of copy.policyEngines ?? []) {
    engine.policies = (engine.policies ?? []).filter((policy: { name: string; statement?: unknown }) => {
      if (typeof policy.statement !== 'string') return true;
      let resolved = true;
      policy.statement = policy.statement.replace(gatewayArn, (match: string, prefix: string, arn: string, account: string) => {
        if (account === targetAccount) return match;
        const name = nameForArn(arn);
        const newArn = name ? targetGateways?.[name]?.gatewayArn : undefined;
        if (!newArn) {
          resolved = false;
          return match;
        }
        return `${prefix}${newArn}"`;
      });
      if (!resolved) console.warn(`Policy "${policy.name}" skipped: its Gateway isn't deployed in account ${targetAccount} yet. Deploy again to add it.`);
      return resolved;
    });
  }
  return copy as T;
}

async function main() {
  // Config root is parent of cdk/ directory. The CLI sets process.cwd() to agentcore/cdk/.
  const configRoot = path.resolve(process.cwd(), '..');
  const configIO = new ConfigIO({ baseDir: configRoot });

  const spec = await configIO.readProjectSpec();
  const targets = await configIO.readAWSDeploymentTargets();

  // The vended CDK project compiles against the published @aws/agentcore-cdk
  // schema type, which may lag the CLI's own AgentCoreProjectSpec (e.g. payments,
  // harnesses, gateway fields). Cast once so those fields are reachable.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const specAny = spec as any;

  // Extract MCP configuration from project spec.
  // Gateway fields are stored in agentcore.json but may not yet be on the
  const mcpSpec = specAny.agentCoreGateways?.length
    ? {
        agentCoreGateways: specAny.agentCoreGateways,
        mcpRuntimeTools: specAny.mcpRuntimeTools,
        unassignedTargets: specAny.unassignedTargets,
      }
    : undefined;

  // Read deployed state for credential ARNs (populated by pre-deploy identity setup)
  let deployedState: Record<string, unknown> | undefined;
  try {
    deployedState = JSON.parse(fs.readFileSync(path.join(configRoot, '.cli', 'deployed-state.json'), 'utf8'));
  } catch {
    // Deployed state may not exist on first deploy
  }

  if (targets.length === 0) {
    throw new Error('No deployment targets configured. Please define targets in agentcore/aws-targets.json');
  }

  // Read harness configs: the full validated spec drives the CFN resource; the
  // role-scoped fields drive the IAM role + container build.
  const projectRoot = path.resolve(configRoot, '..');

  // Read non-S3 KB connector-config files and pass their parsed contents to the
  // L3 verbatim. The L3 does not read files; it expects the parsed
  // connectorParameters keyed by the data source's connectorConfigFile path.
  const connectorParametersByFile: Record<string, Record<string, unknown>> = {};
  for (const kb of specAny.knowledgeBases ?? []) {
    for (const ds of kb.dataSources ?? []) {
      if (ds.type !== 'S3' && ds.connectorConfigFile) {
        const abs = path.resolve(projectRoot, ds.connectorConfigFile);
        try {
          connectorParametersByFile[ds.connectorConfigFile] = JSON.parse(fs.readFileSync(abs, 'utf-8'));
        } catch (err) {
          throw new Error(
            `Could not read connector config '${ds.connectorConfigFile}' for knowledge base '${kb.name}' at ${abs}: ${err instanceof Error ? err.message : err}`
          );
        }
      }
    }
  }

  // Synthesize an AWS::BedrockAgentCore::Harness resource for each harness entry in the spec.
  const harnessConfigs: HarnessConfig[] = [];
  for (const entry of specAny.harnesses ?? []) {
    const harnessDir = path.resolve(projectRoot, entry.path);
    const harnessPath = path.resolve(harnessDir, 'harness.json');
    try {
      const harnessSpec = HarnessSpecSchema.parse(JSON.parse(fs.readFileSync(harnessPath, 'utf-8')));
      harnessConfigs.push({
        name: entry.name,
        executionRoleArn: harnessSpec.executionRoleArn,
        // Only an `existing` memory ref carries a name to wire IAM against; managed memory is
        // owned by the harness (no sibling) and disabled has none — both resolve to undefined.
        memoryName: harnessSpec.memory?.mode === 'existing' ? harnessSpec.memory.name : undefined,
        containerUri: harnessSpec.containerUri,
        hasDockerfile: !!harnessSpec.dockerfile,
        dockerfile: harnessSpec.dockerfile,
        codeLocation: harnessSpec.dockerfile ? harnessDir : undefined,
        tools: harnessSpec.tools,
        skills: harnessSpec.skills,
        apiKeyArn: harnessSpec.model?.apiKeyArn,
        efsAccessPoints: harnessSpec.efsAccessPoints,
        s3AccessPoints: harnessSpec.s3AccessPoints,
        apiFormat: harnessSpec.model?.apiFormat,
        // Full spec + dir drive the AWS::BedrockAgentCore::Harness CFN resource.
        spec: harnessSpec,
        harnessDir,
      });
    } catch (err) {
      throw new Error(
        `Could not read harness.json for "${entry.name}" at ${harnessPath}: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  const app = new App();

  for (const target of targets) {
    const env = toEnvironment(target);
    const stackName = toStackName(spec.name, target.name);

    // Extract credentials from deployed state for this target
    const targetState = (deployedState as Record<string, unknown>)?.targets as
      Record<string, Record<string, unknown>> | undefined;
    const targetResources = targetState?.[target.name]?.resources as Record<string, unknown> | undefined;

    // A target whose deployed stack has a different name was renamed after it was
    // deployed (the original account's target was `default`, now `original`).
    // Synthesizing it would create a second stack beside the live one, so leave it
    // out; the CLI then refuses to deploy it. Invoking it still works.
    const deployedStackName = targetResources?.stackName as string | undefined;
    if (deployedStackName && deployedStackName !== stackName) {
      console.warn(`Target "${target.name}" skipped: its live stack is ${deployedStackName}, not ${stackName}.`);
      continue;
    }

    const credentials = targetResources?.credentials as
      Record<string, { credentialProviderArn: string; clientSecretArn?: string }> | undefined;

    // Payment credential provider ARNs live in the same credentials map as identity credentials
    const paymentCredentials = credentials;

    const paymentSpec = specAny.payments?.length
      ? specAny.payments.map(
          (p: {
            name: string;
            description?: string;
            authorizerType: 'AWS_IAM' | 'CUSTOM_JWT';
            authorizerConfiguration?: unknown;
            autoPayment?: boolean;
            paymentToolAllowlist?: string[];
            networkPreferences?: string[];
            connectors: { name: string; provider?: string; credentialName: string }[];
          }) => ({
            name: p.name,
            description: p.description,
            authorizerType: p.authorizerType,
            authorizerConfiguration: p.authorizerConfiguration,
            autoPayment: p.autoPayment,
            paymentToolAllowlist: p.paymentToolAllowlist,
            networkPreferences: p.networkPreferences,
            connectors: p.connectors.map(c => {
              const credentialProviderArn = paymentCredentials?.[c.credentialName]?.credentialProviderArn;
              if (!credentialProviderArn) {
                // Fail fast with an actionable message rather than passing an empty
                // ARN that fails opaquely server-side at CreatePaymentConnector.
                throw new Error(
                  `Payment connector "${c.name}" on manager "${p.name}" references credential ` +
                    `"${c.credentialName}", but no deployed credential provider was found for it. ` +
                    `Run \`agentcore deploy\` so the credential provider is created first.`
                );
              }
              return { name: c.name, provider: c.provider, credentialProviderArn };
            }),
          })
        )
      : undefined;

    new AgentCoreStack(app, stackName, {
      spec: policiesForTarget(
        spec,
        target.account,
        Object.values(targetState ?? {}).map(t => (t?.resources as Record<string, unknown> | undefined)?.gateways as GatewayArns),
        targetResources?.gateways as GatewayArns
      ),
      mcpSpec,
      credentials,
      connectorParametersByFile,
      harnesses: harnessConfigs.length > 0 ? harnessConfigs : undefined,
      paymentSpec,
      env,
      description: `AgentCore stack for ${spec.name} deployed to ${target.name} (${target.region})`,
      tags: {
        'agentcore:project-name': spec.name,
        'agentcore:target-name': target.name,
      },
    });
  }

  app.synth();
}

main().catch((error: unknown) => {
  console.error('AgentCore CDK synthesis failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
