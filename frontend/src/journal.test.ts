import { it, expect } from 'vitest';
import { dayVisits, yearReview } from './journal';
import type { Photo } from './types';
const photo = (id:string,world:string,time:string,extra:Partial<Photo>={}):Photo=>({id,world,world_id:world,date:'2026-10-03',month:'2026-10',captured_at:`2026-10-03T${time}`,session_id:'s',session_label:'s',favorite:false,tags:[],note:'',filename:id,width:400,height:300,copies:1,date_source:'filename',thumb_url:'',original_url:'',...extra});
it('keeps world revisits in chronological order',()=>{
  const visits=dayVisits([photo('d','A','12:03:00'),photo('b','A','12:01:00'),photo('a','A','12:00:00'),photo('c','B','12:02:00')],'2026-10-03');
  expect(visits.map(v=>v.name)).toEqual(['A','B','A']);expect(visits[0].photos.length).toBe(2);
});
it('counts unique worlds, active days and sessions, excluding other years and invalid dates',()=>{
  const review=yearReview([photo('a','A','12:00:00',{favorite:true}),photo('b','A','12:01:00'),photo('c','B','12:02:00',{session_id:'t'}),photo('old','C','12:00:00',{date:'2025-10-03'}),photo('bad','D','12:00:00',{date:'2026-02-30'})],'2026');
  expect(review.members.length).toBe(3);expect(review.worlds.length).toBe(2);expect(review.sessions).toBe(2);expect(review.days).toBe(1);expect(review.favorites).toBe(1);expect(review.months[9].count).toBe(3);expect(review.chosen[0].id).toBe('a');
});
