import {
  applySettingsPatch,
  parseFlagValue,
  parsePatchInput,
  resolveSkillRoot,
  resolveWorkspacePaths,
} from './lib/runtime.mjs';

export const main = async (args = process.argv.slice(2)) => {
  const configPath = parseFlagValue(args, '--config');
  const openclawBin = parseFlagValue(args, '--openclaw-bin');
  const patch = await parsePatchInput(args);
  const workspacePaths = resolveWorkspacePaths({ configPath });
  const result = await applySettingsPatch({
    patch,
    workspacePaths,
    openclawBin,
    skillRoot: resolveSkillRoot(import.meta.url),
  });

  console.log(JSON.stringify({
    status: 'ok',
    configPath: workspacePaths.configPath,
    patch,
    automation: result.automation,
    config: result.config,
  }, null, 2));
};

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
