/** Serializable TMDB season metadata, shared by both interfaces. */
export type TmdbSeason = {
  number: number
  name: string
  episodeCount: number
  airDate: string
  /** Present for an alternative episode ordering, not an ordinary TV season. */
  groupId?: string
  groupName?: string
}

export type TmdbSeasonList = {
  seasons: TmdbSeason[]
  /** Optional groups can fail without hiding the ordinary seasons. */
  warning: string
}
