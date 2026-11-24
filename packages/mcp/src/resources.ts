// @margoengine/mcp/resources: the docs as MCP resources and a few starter prompts. Resources let a client put a
// package README, its API report or a guide into the model's context without a tool call; prompts are the starting
// requests a user picks from the client's menu (start a scene, port code, fix an error, add a feature), each telling
// the model which tools to use. Written from the MCP specification 2025-11-25, Server, Resources and Prompts.
import { typeError } from '../../shared/errors.js';
import type { Corpus } from './corpus.js';
import type { PromptDefinition, ResourceContents, ResourceInfo, ResourceProvider, ResourceTemplateInfo } from './server.js';

/** The URI scheme of the docs resources: `margo://packages/<id>/readme`, `margo://docs/<path>`. */
export const RESOURCE_SCHEME = 'margo://';

const MARKDOWN = 'text/markdown';

/** The `margo://docs/...` name of a docs page path (`docs/guides/kits.md` is `margo://docs/guides/kits`). */
const docUri = (path: string): string => `${RESOURCE_SCHEME}docs/${path.replace(/^docs\//, '').replace(/\.md$/, '')}`;

/** A package's API reports as one markdown page, one section per entry point. */
function apiText(pkg: Corpus['packages'][number]): string {
  return pkg.entries.map((entry) => `# ${entry.specifier}\n\n${entry.report.trim()}\n`).join('\n');
}

const bytes = (text: string): number => new TextEncoder().encode(text).length;

/**
 * The docs of a corpus as resources: the engine README (`margo://readme`), each package's README and API report
 * (`margo://packages/<id>/readme`, `margo://packages/<id>/api`) and each docs page (`margo://docs/<path>`), with
 * templates for the package and docs addresses. Package ids are the short names (`sciviz`).
 */
export function createDocResources(corpus: Pick<Corpus, 'readme' | 'packages' | 'docs'>): ResourceProvider {
  if (!corpus || !Array.isArray(corpus.packages) || !Array.isArray(corpus.docs))
    throw typeError('createDocResources needs a corpus with packages and docs', 'mcp');
  const texts = new Map<string, { info: ResourceInfo; text: () => string }>();
  const add = (info: Omit<ResourceInfo, 'mimeType' | 'size'>, text: () => string) =>
    texts.set(info.uri, { info: { ...info, mimeType: MARKDOWN, size: bytes(text()) }, text });
  add(
    { uri: `${RESOURCE_SCHEME}readme`, name: 'readme', title: 'Margo Engine README', description: 'What Margo is, how to install it and the package map.' },
    () => corpus.readme,
  );
  for (const pkg of corpus.packages) {
    add(
      { uri: `${RESOURCE_SCHEME}packages/${pkg.id}/readme`, name: `${pkg.id}/readme`, title: `${pkg.name} README`, description: pkg.description },
      () => pkg.readme,
    );
    if (pkg.entries.length)
      add(
        {
          uri: `${RESOURCE_SCHEME}packages/${pkg.id}/api`,
          name: `${pkg.id}/api`,
          title: `${pkg.name} API`,
          description: `Every export of ${pkg.name} with its declaration, per entry point.`,
        },
        () => apiText(pkg),
      );
  }
  for (const doc of corpus.docs)
    add({ uri: docUri(doc.path), name: doc.path, title: doc.title, ...(doc.summary ? { description: doc.summary } : {}) }, () => doc.text);
  const list = [...texts.values()].map((entry) => entry.info);
  const templates: ResourceTemplateInfo[] = [
    {
      uriTemplate: `${RESOURCE_SCHEME}packages/{id}/readme`,
      name: 'package-readme',
      title: 'Package README',
      description: 'The README of one package, by its short name (sciviz, physics, stage).',
      mimeType: MARKDOWN,
    },
    {
      uriTemplate: `${RESOURCE_SCHEME}packages/{id}/api`,
      name: 'package-api',
      title: 'Package API',
      description: 'Every export of one package with its declaration, per entry point.',
      mimeType: MARKDOWN,
    },
    {
      uriTemplate: `${RESOURCE_SCHEME}docs/{+path}`,
      name: 'doc',
      title: 'Docs page',
      description: 'A page of the docs folder by its path without .md (limits, guides/kits).',
      mimeType: MARKDOWN,
    },
  ];
  return {
    list: () => list,
    templates: () => templates,
    read(uri: string): ResourceContents[] | undefined {
      // A package may be named in any spelling: margo://packages/@margoengine/sciviz/readme is sciviz.
      const normal = uri.replace(/^margo:\/\/packages\/(?:@?margoengine\/)/, `${RESOURCE_SCHEME}packages/`);
      const found = texts.get(normal);
      return found ? [{ uri, mimeType: MARKDOWN, text: found.text() }] : undefined;
    },
  };
}

const text = (value: string) => ({ role: 'user' as const, content: { type: 'text' as const, text: value } });

/** Arguments of a prompt, checked: every value a string. */
function argument(args: Record<string, string>, name: string): string {
  return (args[name] ?? '').trim();
}

/** The starter prompts: `start_scene`, `port_code`, `fix_error` and `add_feature`. */
export function createStarterPrompts(): PromptDefinition[] {
  return [
    {
      name: 'start_scene',
      title: 'Start a Margo scene',
      description: 'Sets up a first scene with the stage: a canvas, objects, lights and camera controls.',
      arguments: [{ name: 'idea', description: 'What the scene should show (default: a lit box on a ground with orbit controls).' }],
      get(args) {
        const idea = argument(args, 'idea') || 'a lit box on a ground plane with orbit controls';
        return {
          description: 'Start a Margo scene',
          messages: [
            text(
              `Build a Margo Engine scene that shows ${idea}. Use the stage (createStage from margoengine) unless a feature needs a package of its own. First call list_examples and search_docs for the closest example, then get_package for each package you import. Write one TypeScript module, call check_snippet on it and fix every problem it reports, and if render_snippet is offered, render it and check the picture. Import only what you use.`,
            ),
          ],
        };
      },
    },
    {
      name: 'port_code',
      title: 'Port code to Margo',
      description: 'Converts code from another 3D library to Margo, class by class, with the porting guide.',
      arguments: [
        { name: 'code', description: 'The code to convert.', required: true },
        { name: 'from', description: 'The library it uses (default: the first library port_to_margo knows).' },
      ],
      get(args) {
        const from = argument(args, 'from');
        return {
          description: 'Port code to Margo',
          messages: [
            text(
              `Convert this code to Margo Engine${from ? ` (it uses ${from})` : ''}. For each class or function of the other library it uses, call port_to_margo${from ? ` with from set to ${from}` : ''} and follow the Margo package and calls it gives; where a row is PARTIAL, MISSING or NOT PLANNED, say what changes. Then call check_snippet on the result and fix what it reports.\n\n\`\`\`\n${argument(args, 'code')}\n\`\`\``,
            ),
          ],
        };
      },
    },
    {
      name: 'fix_error',
      title: 'Fix a Margo error',
      description: 'Explains a Margo error from the error help page and fixes the code that threw it.',
      arguments: [
        { name: 'error', description: 'The error message or stack trace.', required: true },
        { name: 'code', description: 'The code that threw it, if at hand.' },
      ],
      get(args) {
        const code = argument(args, 'code');
        return {
          description: 'Fix a Margo error',
          messages: [
            text(
              `This Margo Engine error came up:\n\n\`\`\`\n${argument(args, 'error')}\n\`\`\`\n\nCall explain_error with it for the cause and the fix, look up any API it names with search_docs, then fix the code${code ? ' below' : ''} and check it with check_snippet.${code ? `\n\n\`\`\`ts\n${code}\n\`\`\`` : ''}`,
            ),
          ],
        };
      },
    },
    {
      name: 'add_feature',
      title: 'Add a Margo feature',
      description: 'Finds the optional package for a feature and adds it to existing code.',
      arguments: [
        { name: 'feature', description: 'The feature to add (shadows, physics, a sky, post-processing).', required: true },
        { name: 'code', description: 'The code to add it to, if any.' },
      ],
      get(args) {
        const code = argument(args, 'code');
        return {
          description: 'Add a Margo feature',
          messages: [
            text(
              `Add ${argument(args, 'feature')} to this Margo Engine project. Margo's core is small and every feature is an optional package or a stage feature entry: call list_packages and search_docs to find the one that provides it, read its README with get_package, import only that entry, and check the result with check_snippet.${code ? `\n\n\`\`\`ts\n${code}\n\`\`\`` : ''}`,
            ),
          ],
        };
      },
    },
  ];
}
