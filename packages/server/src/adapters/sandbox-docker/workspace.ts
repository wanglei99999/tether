/** 工作区怎么存、怎么挂进容器。只在 Docker 适配器里用，core 看不到。 */
export interface WorkspaceStorage {
	readonly mode: "image" | "directory";
	/** 建好会话的工作区（已有就复用），返回 docker run 里把它挂到 /workspace 的参数。 */
	prepare(sessionId: string, diskMb: number): Promise<string[]>;
	/**
	 * 容器 start 之前调用。返回 false 表示容器记着的挂载已经失效（宿主重启后 loop 设备换了），
	 * 调用方要删掉容器、重新 prepare、按原配置重建。
	 */
	beforeStart(sessionId: string): Promise<boolean>;
	/** 删掉工作区和它占用的一切（卷、loop 设备、文件）；不存在不报错。 */
	remove(sessionId: string): Promise<void>;
}
