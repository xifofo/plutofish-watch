import { expect, test } from 'bun:test'
import { validateSource } from '../src/main/bindings'
import { releaseSource, sourceReviewReason } from '../vendor/publisher/src/integrations/plutofish/release-specs'

test('来源预设规范化和输入校验，空预设不会补 WEB-DL', () => {
  expect(validateSource({ platform: ' yk ', type: 'webrip' })).toEqual({ platform: 'YOUKU', type: 'WEBRip' })
  expect(validateSource()).toEqual({ platform: undefined, type: undefined })
  for (const value of [null, [], { platform: 3 }, { type: {} }, { platform: '../file' }, { type: 'default' }]) {
    expect(() => validateSource(value as never)).toThrow()
  }
  expect(sourceReviewReason(releaseSource('Movie.1080p.AVC', validateSource()))).toContain('类型')
  expect(sourceReviewReason(releaseSource('Movie.1080p.WEB-DL.AVC', validateSource()))).toContain('平台')
  expect(sourceReviewReason(releaseSource('Movie.1080p.BluRay.AVC', validateSource()))).toBe('')
})
