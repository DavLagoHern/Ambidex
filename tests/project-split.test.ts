import { describe, expect, it } from 'vitest'
import { selectSplitProject, splitWithProject } from '../src/shared/project-split'

describe('dos proyectos completos', () => {
  it('abre dos proyectos distintos y respeta el destino elegido', () => {
    expect(splitWithProject(['a', 'b', 'c'], 'a', 'c')).toEqual(['a', 'c'])
    expect(splitWithProject(['a', 'b'], 'a', 'a')).toEqual(['a', 'b'])
    expect(splitWithProject(['a'], 'a')).toBeNull()
    expect(splitWithProject(['a', 'b'], null)).toBeNull()
  })
  it('enfoca un lado sin intercambiar ni duplicar los proyectos', () => {
    expect(selectSplitProject(['a', 'b'], 'a', 'b')).toEqual(['a', 'b'])
    expect(selectSplitProject(['a', 'b'], 'b', 'a')).toEqual(['a', 'b'])
  })
  it('las demás pestañas se abren en el lado enfocado', () => {
    expect(selectSplitProject(['a', 'b'], 'a', 'c')).toEqual(['c', 'b'])
    expect(selectSplitProject(['a', 'b'], 'b', 'c')).toEqual(['a', 'c'])
    expect(selectSplitProject(null, 'a', 'c')).toBeNull()
  })
})
