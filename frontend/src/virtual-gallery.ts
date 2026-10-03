import { justified, masonry, ratioOf } from './gallery-layout';
import type { Layout } from './preferences';
import type { Photo } from './types';

export const PHOTO_BLOCK_SIZE = 24;
export function estimateBlockHeight(photos: readonly Photo[], width: number, layout: Layout, metrics = {gap:19,minWidth:216,targetHeight:220}): number {
  const w=Math.max(1,width);const gap=metrics.gap;const footer=45;
  if(layout==='grid') {
    const columns=Math.max(1,Math.floor((w+gap)/(metrics.minWidth+gap)));
    return Math.max(0,Math.ceil(photos.length/columns)*(((w-gap*(columns-1))/columns)*.75+footer+gap)-gap);
  }
  const items=photos.map(p=>({ratio:ratioOf(p.width/p.height),footerHeight:footer}));
  return (layout==='masonry'?masonry(items,w,gap,metrics.minWidth):justified(items,w,gap,metrics.targetHeight)).height;
}
