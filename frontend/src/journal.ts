import { worldKey, worldName } from './model';
import { dateNumber } from './collections';
import type { Photo } from './types';

export function dayVisits(photos: readonly Photo[], date: string) {
  const ordered = photos.filter(p=>p.date===date).sort((a,b)=>a.captured_at.localeCompare(b.captured_at)||a.id.localeCompare(b.id));
  const visits: {key:string;name:string;start:string;end:string;photos:Photo[]}[] = [];
  for (const photo of ordered) {
    const last = visits.at(-1);
    if (last && last.key===worldKey(photo) && photo.session_id===last.photos[0].session_id) {
      last.photos.push(photo);last.end=photo.captured_at;
    } else visits.push({key:worldKey(photo),name:worldName(photo),start:photo.captured_at,end:photo.captured_at,photos:[photo]});
  }
  return visits;
}
export function yearReview(photos: readonly Photo[], year: string) {
  const members = photos.filter(p=>dateNumber(p.date)!==null && p.date.slice(0,4)===year);
  const worlds = new Map<string,{name:string;count:number}>();
  const months = Array.from({length:12},(_,i)=>({month:i+1,count:0}));
  for (const p of members) {
    months[Number(p.date.slice(5,7))-1].count++;
    const key=worldKey(p);
    if(key!=='__unknown__'){const group=worlds.get(key)||{name:worldName(p),count:0};group.count++;worlds.set(key,group);}
  }
  const ranked = [...members].sort((a,b)=>Number(b.favorite)-Number(a.favorite)||Number(!!b.note.trim())-Number(!!a.note.trim())||b.captured_at.localeCompare(a.captured_at));
  const seen = new Set<string>();
  const diverse = ranked.filter(p=>{const key=worldKey(p);if(seen.has(key))return false;seen.add(key);return true;});
  const chosen = [...diverse.slice(0,6), ...ranked.filter(p=>!diverse.slice(0,6).some(q=>q.id===p.id))].slice(0,12);
  return {members,months,worlds:[...worlds.values()].sort((a,b)=>b.count-a.count),sessions:new Set(members.map(p=>p.session_id).filter(Boolean)).size,
    days:new Set(members.map(p=>p.date)).size,favorites:members.filter(p=>p.favorite).length,chosen};
}
