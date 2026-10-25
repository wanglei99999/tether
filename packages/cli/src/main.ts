import { run } from "./commands.ts";

// 先置 1：bin 用动态 import 加载这里，命令还没结束进程就退出（事件循环意外空了）时，
// Node 不报未完成的顶层 await，而是按 exitCode 退出，不能让它看起来像成功
process.exitCode = 1;
const code = await run(process.argv.slice(2), {
	out: (text) => process.stdout.write(text),
	err: (text) => process.stderr.write(text),
	env: process.env,
});
process.exitCode = code;
