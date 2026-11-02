import type { PtApi } from '../../../preload/api'

export const pt: PtApi = (window as unknown as { pt: PtApi }).pt
