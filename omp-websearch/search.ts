// Run under bun, never node: omp's source is TypeScript and uses bun APIs. Prints one line
// "@@OMP@@{json}" on stdout so any log noise before it cannot corrupt the result.
// Imports only by path under <omp-src-dir>: a bare package name would resolve from this file's own
// location, where omp's dependencies are not installed.
// usage: bun search.ts <omp-src-dir> <query>
import { join } from "node:path";

const [src, query] = process.argv.slice(2);
const out = (obj: object) => process.stdout.write(`\n@@OMP@@${JSON.stringify(obj)}\n`);

try {
	if (!src || !query) throw new Error("usage: search.ts <omp-src-dir> <query>");
	const { Settings } = await import(join(src, "config/settings.ts"));
	await Settings.init({ cwd: process.cwd() });
	const { runSearchQuery } = await import(join(src, "web/search/index.ts"));
	const r = await runSearchQuery({ query });
	const text = r.content.map((c: { text: string }) => c.text).join("\n");
	const sources = (r.details.response.sources ?? []).map((s: { title: string; url: string }) => ({
		title: s.title,
		url: s.url,
	}));
	out({ ok: !r.details.error, text, sources });
} catch (e) {
	out({ ok: false, text: `Error: ${(e as Error).message}`, sources: [] });
}
process.exit(0);
