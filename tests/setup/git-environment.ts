/* A git hook exports GIT_DIR, GIT_INDEX_FILE and GIT_WORK_TREE, and they win over discovery: a
   fixture's own `git init/add/commit` then retargets the INVOKING checkout — stray commits, a
   staged deletion, `core.bare=true` on the primary checkout — while the fixture gets no repository
   at all. It fires only under the hook, so every direct run of the suite looks clean. Stripping it
   centrally is the only placement that also covers suites added later. */
const REPOSITORY_SCOPED_VARIABLES = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX",
  "GIT_CONFIG",
] as const;

for (const variable of REPOSITORY_SCOPED_VARIABLES) {
  delete process.env[variable];
}

/* Host global/system config would otherwise decide hooksPath, templateDir, insteadOf, gpg signing
   and submodule.recurse for fixture repositories, so a green suite would prove nothing beyond the
   machine it ran on. Fixtures supply identity through the GIT_AUTHOR and GIT_COMMITTER variables
   instead. */
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
