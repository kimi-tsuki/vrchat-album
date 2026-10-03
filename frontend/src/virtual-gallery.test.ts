import { it, expect } from 'vitest';
import { estimateBlockHeight } from './virtual-gallery';
import type { Photo } from './types';
it('reserves space for offscreen blocks at desktop and mobile widths',()=>{
  const photos=Array.from({length:24},()=>({width:640,height:480} as Photo));
  for(const layout of ['grid','masonry','justified'] as const){
    expect(estimateBlockHeight(photos,900,layout)).toBeGreaterThan(500);
    expect(estimateBlockHeight(photos,320,layout)).toBeGreaterThan(estimateBlockHeight(photos,900,layout));
    expect(estimateBlockHeight([],900,layout)).toBe(0);
  }
});
