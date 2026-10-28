/** 工作区怎么存、怎么挂进容器。只在 Docker 适配器里用，core 看不到。 */
export interface WorkspaceStorage {
	readonly mode: "image" | "directory";
	/** 快照在磁盘上的后缀：镜像模式是一个 .img 文件，目录模式是一个目录。 */
	readonly snapshotSuffix: string;
	/**
	 * 建好会话的工作区（已有就复用），返回 docker run 里把它挂到 /workspace 的参数。
	 * 给了 from（一张快照在宿主上的路径）就用它的内容新建，大小跟着快照，diskMb 不起作用。
	 */
	prepare(sessionId: string, diskMb: number, from?: string): Promise<string[]>;
	/**
	 * 把工作区复制到 target（快照）。调用方保证这时没有进程在写（容器已暂停或已停止）。
	 * previous 是这个会话上一张快照，目录模式用它共享没变的文件。
	 */
	copyOut(sessionId: string, target: string, previous?: string): Promise<void>;
	/**
	 * 容器 start 之前调用。返回 false 表示容器记着的挂载已经失效（宿主重启后 loop 设备换了），
	 * 调用方要删掉容器、重新 prepare、按原配置重建。
	 */
	beforeStart(sessionId: string): Promise<boolean>;
	/** 删掉工作区和它占用的一切（卷、loop 设备、文件）；不存在不报错。 */
	remove(sessionId: string): Promise<void>;
}
