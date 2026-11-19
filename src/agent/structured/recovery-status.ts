import type { ProviderRecoveryStatus } from '../types';

export function recoveryStatusText(status: ProviderRecoveryStatus): string {
  const label: Record<string, string> = {
    normal: '正常执行', tool_running: '工具运行中', working_stalled: '长时间无新进展', provider_retrying: 'Provider 原生重试中',
    bridge_backoff: 'Bridge 退避等待', recovery_exhausted: '恢复预算已耗尽，等待用户处理',
    needs_attention: '等待用户处理', status_unknown: '状态未知', disabled: 'Bridge 自动恢复已关闭', stopped: '已停止自动恢复',
  };
  const time = (value?: number) => value === undefined ? '未知' : new Date(value).toISOString();
  return `${label[status.state] ?? status.state} · 自动恢复 ${status.attempts} 次 · 故障预算 ${Math.floor(status.usedSeconds / 60)}/${Math.floor(status.budgetSeconds / 60)} 分钟` +
    `\n底层 turn：${status.underlyingTurn === 'running' ? '仍在运行' : status.underlyingTurn === 'terminal' ? '已结束' : '未知'}；最近活动：${time(status.lastActivityAt)}` +
    (status.nextRecoveryAt ? `；下次恢复：${time(status.nextRecoveryAt)}` : '') +
    (status.waitingReason ? `\n${status.waitingReason}` : '') +
    (status.lastError ? `\n最近错误：${status.lastError.slice(0, 1000)}` : '');
}
