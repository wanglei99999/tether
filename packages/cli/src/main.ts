import { run } from "./commands.ts";

const code = await run(process.argv.slice(2), {
	out: (text) => process.stdout.write(text),
	err: (text) => process.stderr.write(text),
	env: process.env,
});
process.exitCode = code;
