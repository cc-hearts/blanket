/**
 * 权限开关的公共词汇。
 *
 * 设计要点：适配器**只计算**要写什么（返回 PlannedEdit），真正落盘由编排层统一
 * 做备份 + 原子写。这样 --dry-run 免费得到，适配器也容易单测。
 */

/** 一个可控制的权限开关。 */
export type SwitchId = "full-access" | "trust-all";

export const SWITCHES: readonly { id: SwitchId; label: string; hint: string }[] = [
  {
    id: "full-access",
    label: "完全访问权限",
    hint: "不再弹审批、不限制写入范围（危险的开关，等于把机器的写权限交给 agent）",
  },
  {
    id: "trust-all",
    label: "信任所有项目",
    hint: "新目录不再弹「是否信任此项目」，对以后新建的项目一并生效",
  },
] as const;

/** 读到的开关现状。 */
export interface SwitchState {
  id: SwitchId;
  /** 该 agent 是否支持这个开关 */
  supported: boolean;
  /** 当前是否已开启 */
  enabled: boolean;
  /** 读到的事实，直接展示给用户（例如「settings.yaml: permission.defaultPreset = danger-full-access」） */
  evidence: string;
  /** supported=false 时说明原因 */
  unsupportedReason?: string;
}

/** 一次计划中的文件写入。适配器只产出它，不执行。 */
export interface PlannedEdit {
  /** 目标文件绝对路径 */
  path: string;
  /** 期望写入的完整新内容 */
  next: string;
  /** 这条改动做了什么（一行） */
  note: string;
}

/** 某个开关的完整计划：把开关设为 on 需要哪些写入。 */
export interface SwitchPlan {
  switchId: SwitchId;
  /** 目标状态 */
  on: boolean;
  /** 需要的写入；为空表示已经是目标状态（幂等） */
  edits: PlannedEdit[];
  /** 为空时给用户的解释，例如「已开启，无需改动」 */
  note?: string;
}

/** 一个 agent 的权限适配器。 */
export interface AgentTarget {
  /** 稳定 id，用于 --only */
  id: string;
  /** 展示名 */
  name: string;
  /** 可执行文件名，用于判断是否安装 */
  bin: string;
  /** 读当前状态。任何一步读失败都不应抛出，而是降级成 evidence 里的说明。 */
  inspect(): Promise<SwitchState[]> | SwitchState[];
  /** 计算把某开关设为 on 需要写什么。不落盘。 */
  plan(switchId: SwitchId, on: boolean): Promise<SwitchPlan> | SwitchPlan;
}

/** 落盘结果。 */
export interface ApplyResult {
  path: string;
  note: string;
  status: "written" | "skipped" | "failed";
  /** 备份文件路径（status=written 时） */
  backup?: string;
  error?: string;
}
