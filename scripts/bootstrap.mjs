import {
  ensureBootstrap,
  reconcileAutomationJobs,
  resolveSkillRoot,
} from './lib/runtime.mjs';

export const main = async (args = process.argv.slice(2)) => {
  const configPath = args.includes('--config') ? args[args.indexOf('--config') + 1] : undefined;
  const openclawBin = args.includes('--openclaw-bin') ? args[args.indexOf('--openclaw-bin') + 1] : undefined;
  const skillRoot = resolveSkillRoot(import.meta.url);
  const bootstrap = await ensureBootstrap({
    configPath,
    markDisclosureShown: !args.includes('--keep-disclosure-pending'),
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
    workspaceDir: bootstrap.workspacePaths.workspaceDir,
    clawcareDir: bootstrap.workspacePaths.clawcareDir,
    wroteConfig: bootstrap.wroteConfig,
    disclosurePending: bootstrap.disclosurePending,
    bootstrapDisclosure: bootstrap.bootstrapDisclosure,
    automation,
  }, null, 2));
};

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
