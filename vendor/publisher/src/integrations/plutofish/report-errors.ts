/** 资源登记只展示约定业务码对应的固定原因；响应正文、SQL 和供应商凭据不进入界面。 */
const reasons: Record<string, { message: string; retryable: boolean }> = {
  CONTENT_EDITION_MISSING: { message: '服务端数据库缺少发行规格字段（edition），请完成数据库迁移后重试登记', retryable: false },
  CONTENT_SCHEMA_MISMATCH: { message: '服务端数据库缺少资源登记所需字段或数据表，请完成数据库迁移后重试', retryable: false },
  CONTENT_DATABASE_BUSY: { message: '资源登记遇到数据库事务冲突或锁等待，请稍后重试原任务', retryable: true },
  CONTENT_DATABASE_UNAVAILABLE: { message: '资源登记无法连接数据库，请稍后重试原任务', retryable: true },
  CONTENT_DATABASE_PLAN_STALE: { message: '服务端数据库连接仍使用旧结构，请管理员重建数据库连接后重试', retryable: true },
  CONTENT_DATABASE_CONSTRAINT: { message: '资源登记未通过数据库一致性校验，请提供请求 ID 供管理员核对', retryable: false },
  CONTENT_DATABASE_ERROR: { message: '资源登记数据库操作失败，请提供请求 ID 供管理员排查', retryable: true },
  CONTENT_REPORT_FAILED: { message: '资源登记内部处理失败，请提供请求 ID 供管理员排查', retryable: true },
  CONTENT_FILE_REMOVED: { message: '该文件已从版本中删除，重新发布需要新的文件标识', retryable: false },
  CONTENT_FILE_READY: { message: '文件已登记就绪，不能覆盖，请检查原任务回执', retryable: false },
  CONTENT_IDENTITY_CONFLICT: { message: '文件标识已绑定其他文件或网盘来源，请检查原任务绑定', retryable: false },
  CONTENT_SEQUENCE_CONFLICT: { message: '同一上报序号对应了不同内容，请检查原任务状态', retryable: false },
  CONTENT_PROGRESS_REGRESSION: { message: '上报进度倒退或文件内容已改变，请检查原任务', retryable: false },
  CONTENT_RETRY_REQUIRED: { message: '失败后的上报需要新的重试编号，请从原任务重试', retryable: false },
  PUBLISHER_RELEASE_CONFLICT: { message: '版本标识已绑定其他作品或季，请核对目标版本', retryable: false },
  PUBLISHER_WORK_CHANGED: { message: '作品关联已改变，请核对作品信息后重新上报', retryable: false },
}

export function resourceReportReason(code: unknown): { message: string; retryable: boolean } | undefined {
  return typeof code === 'string' && Object.hasOwn(reasons, code) ? reasons[code] : undefined
}
