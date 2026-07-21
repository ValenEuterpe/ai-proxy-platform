import { describe, expect, it } from 'vitest'
import { buildPublicModelId, parsePublicModelId } from '../src/lib/modelId'

describe('parsePublicModelId', () => {
	it('splits a simple namespaced id', () => {
		expect(parsePublicModelId('bil/gpt-5.5')).toEqual({
			channelName: 'bil',
			rawModelId: 'gpt-5.5',
		})
	})

	it('splits on the FIRST slash only (raw id may contain slashes)', () => {
		expect(parsePublicModelId('bil/openai/gpt-4o')).toEqual({
			channelName: 'bil',
			rawModelId: 'openai/gpt-4o',
		})
	})

	it('returns null when there is no slash', () => {
		expect(parsePublicModelId('gpt-5.5')).toBeNull()
	})

	it('returns null when the channel name is empty (leading slash)', () => {
		expect(parsePublicModelId('/gpt-5.5')).toBeNull()
	})

	it('returns null when the raw model id is empty (trailing slash)', () => {
		expect(parsePublicModelId('bil/')).toBeNull()
	})

	it('returns null for empty input', () => {
		expect(parsePublicModelId('')).toBeNull()
	})
})

describe('buildPublicModelId', () => {
	it('joins channel name and raw model id', () => {
		expect(buildPublicModelId('bil', 'gpt-5.5')).toBe('bil/gpt-5.5')
	})

	it('round-trips with parsePublicModelId', () => {
		const publicId = buildPublicModelId('sal', 'openai/gpt-4o')
		expect(parsePublicModelId(publicId)).toEqual({
			channelName: 'sal',
			rawModelId: 'openai/gpt-4o',
		})
	})
})
