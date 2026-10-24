import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGES = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const ADAPTERS = join(PACKAGES, "server", "src", "adapters");
/** 组装根：只有这两个文件能同时看到 pi 和各个适配器。 */
const COMPOSITION_ROOTS = ["main.ts", "app.ts"].map((name) => join(PACKAGES, "server", "src", name));

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

interface SourceImport {
	file: string;
	specifier: string;
}

/** 目录不存在时抛错：骨架没建好，架构测试也应该失败。 */
function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sourceFiles(path);
		return path.endsWith(".ts") ? [path] : [];
	});
}

function importsOf(dir: string): SourceImport[] {
	return sourceFiles(dir).flatMap((file) =>
		[...readFileSync(file, "utf8").matchAll(IMPORT)].map((match) => ({ file, specifier: match[1] })),
	);
}

function isRelative(specifier: string): boolean {
	return specifier.startsWith("./") || specifier.startsWith("../");
}

function packageName(specifier: string): string {
	const parts = specifier.split("/");
	return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function describeViolations(found: SourceImport[]): string[] {
	return found.map(({ file, specifier }) => `${relative(PACKAGES, file)} → ${specifier}`);
}

function onlyImports(dir: string, allowed: readonly string[]): string[] {
	return describeViolations(
		importsOf(dir).filter(
			({ specifier }) => !isRelative(specifier) && !allowed.includes(packageName(specifier)),
		),
	);
}

describe("package boundaries", () => {
	it("core imports only relative paths and typebox", () => {
		expect(onlyImports(join(PACKAGES, "core", "src"), ["typebox"])).toEqual([]);
	});

	it("testkit imports only core, vitest and relative paths", () => {
		expect(onlyImports(join(PACKAGES, "testkit", "src"), ["@tether/core", "vitest"])).toEqual([]);
	});

	it("no adapter imports another adapter", () => {
		const adapters = readdirSync(ADAPTERS).filter((name) => statSync(join(ADAPTERS, name)).isDirectory());
		const violations = adapters.flatMap((adapter) => {
			const own = join(ADAPTERS, adapter);
			return importsOf(own).filter(({ file, specifier }) => {
				if (!isRelative(specifier)) return false;
				const target = resolve(dirname(file), specifier);
				return target.startsWith(ADAPTERS + sep) && !target.startsWith(own + sep);
			});
		});
		expect(describeViolations(violations)).toEqual([]);
	});

	it("pi packages appear only in adapters and the composition roots", () => {
		const dirs = ["core", "testkit", "server", "sdk", "cli"].map((name) => join(PACKAGES, name, "src"));
		const violations = dirs
			.flatMap((dir) => importsOf(dir))
			.filter(
				({ file, specifier }) =>
					specifier.startsWith("@earendil-works/") &&
					!file.startsWith(ADAPTERS + sep) &&
					!COMPOSITION_ROOTS.includes(file),
			);
		expect(describeViolations(violations)).toEqual([]);
	});

	it("sdk imports only core and relative paths", () => {
		expect(onlyImports(join(PACKAGES, "sdk", "src"), ["@tether/core"])).toEqual([]);
	});

	it("pins every dependency to an exact version", () => {
		const loose = readdirSync(PACKAGES).flatMap((name) => {
			const manifest = JSON.parse(readFileSync(join(PACKAGES, name, "package.json"), "utf8"));
			const deps = { ...manifest.dependencies, ...manifest.devDependencies };
			return Object.entries(deps)
				.filter(([, version]) => /^[~^]/.test(String(version)))
				.map(([dep, version]) => `${name}: ${dep}@${version}`);
		});
		expect(loose).toEqual([]);
	});
});
