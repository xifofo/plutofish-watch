/** 本地文件选择的可展示信息；确认令牌只在当前主进程中有效。 */
export type PublicationFileChoice = {
  token: string; path: string; name: string; size: number
  seasonNumber?: number; episodeNumber?: number
  numbersFromName: boolean; canEditNumbers: boolean
}
export type PublicationFileNumbers = { seasonNumber: number; episodeNumber: number }
