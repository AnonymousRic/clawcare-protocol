import {
  ensureBootstrap,
  parseHostCapabilityFlags,
  reconcileAutomationJobs,
  resolveSkillRoot,
} from './lib/runtime.mjs';

export const main = async (args = process.argv.slice(2)) => {
  const configPath = args.includes('--config') ? args[args.indexOf('--config') + 1] : undefined;
  const locatorPath = args.includes('--locator') ? args[args.indexOf('--locator') + 1] : undefined;
  const openclawBin = args.includes('--openclaw-bin') ? args[args.indexOf('--openclaw-bin') + 1] : undefined;
  const hostCapabilities = parseHostCapabilityFlags(args);
  const skillRoot = resolveSkillRoot(import.meta.url);
  const bootstrap = await ensureBootstrap({
    configPath,
    locatorPath,
    markDisclosureShown: !args.includes('--keep-disclosure-pending'),
    hostCapabilities,
  });
  const automation = await reconcileAutomationJobs({
    config: bootstrap.config,
    workspacePaths: bootstrap.workspacePaths,
    skillRoot,
    openclawBin,
  });

  console.log(JSON.stringify({
    status: 'ok',
    configPath: bootstrap.workspacePaths.configPath,
    locatorPath: bootstrap.workspacePaths.locatorPath,
    workspaceDir: bootstrap.workspacePaths.workspaceDir,
    clawcareDir: bootstrap.workspacePaths.clawcareDir,
    hostLocator: bootstrap.workspacePaths.hostLocator,
    hostProfile: bootstrap.hostProfile,
    wroteConfig: bootstrap.wroteConfig,
    wroteLocator: bootstrap.wroteLocator,
    disclosurePending: bootstrap.disclosurePending,
    bootstrapDisclosure: bootstrap.bootstrapDisclosure,
    automation,
  }, null, 2));
};

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
