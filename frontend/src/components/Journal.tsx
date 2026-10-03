import { Button, Tabs } from '@heroui/react';
import { useMemo, useState } from 'react';
import { dayVisits, yearReview } from '../journal';
import { dateText, worldName } from '../model';
import { dateNumber, shiftDate } from '../collections';
import type { AlbumHook } from '../useAlbum';

export function Journal({album}:{album:AlbumHook}) {
  const [mode,setMode]=useState('day');
  const [day,setDay]=useState(album.sidebar.latestDate || album.today);
  const [year,setYear]=useState((album.sidebar.latestDate || album.today).slice(0,4));
  const [limit,setLimit]=useState(24);
  const visits=useMemo(()=>dayVisits(album.photos,day),[album.photos,day]);
  const review=useMemo(()=>yearReview(album.photos,year),[album.photos,year]);
  const years=useMemo(()=>[...new Set(album.photos.filter(p=>dateNumber(p.date)!==null).map(p=>p.date.slice(0,4)))].sort().reverse(),[album.photos]);
  const maxMonth=Math.max(1,...review.months.map(m=>m.count));
  const fallback=album.photos.some(p=>(mode==='day'?p.date===day:p.date.startsWith(year)) && p.date_source==='modified');
  const exportReview=()=>{
    const report={format:'vrchat-album-year-review',year,photos:review.members.length,worlds:review.worlds,sessions:review.sessions,active_days:review.days,favorites:review.favorites,months:review.months,selected:review.chosen.map(p=>({id:p.id,date:p.date,world:worldName(p),note:p.note}))};
    const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download=`vrchat-review-${year}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  return <section className="album-journal" aria-label="游玩日记与年度回顾"><div className="discovery-heading"><div><p className="eyebrow">YOUR JOURNEY, CHAPTER BY CHAPTER</p><h2>走过的世界，都有迹可循</h2><p>按照片时间还原漫游足迹。照片上的备注就是这段回忆的日记，点击照片即可继续填写。</p></div></div>
    <Tabs selectedKey={mode} onSelectionChange={key=>setMode(String(key))}><Tabs.ListContainer><Tabs.List aria-label="足迹视图"><Tabs.Tab id="day">游玩日记<Tabs.Indicator/></Tabs.Tab><Tabs.Tab id="year">年度回顾<Tabs.Indicator/></Tabs.Tab></Tabs.List></Tabs.ListContainer></Tabs>
    {mode==='day' ? <><div className="album-journal-controls"><Button size="sm" variant="ghost" aria-label="日记前一天" onPress={()=>{setDay(shiftDate(day,-1));setLimit(24);}}>←</Button><label className="album-native-field">回看日期<input aria-label="日记日期" type="date" value={day} onChange={e=>{if(dateNumber(e.target.value)!==null){setDay(e.target.value);setLimit(24);}}}/></label><Button size="sm" variant="ghost" aria-label="日记后一天" onPress={()=>{setDay(shiftDate(day,1));setLimit(24);}}>→</Button><Button size="sm" variant="secondary" onPress={()=>setDay(album.sidebar.latestDate || album.today)}>最近的一天</Button></div>
      <h3>{dateText(day)} · {visits.length} 段足迹</h3><div className="album-timeline">{visits.slice(0,limit).map((visit,index)=><article key={`${visit.start}:${index}`} className="album-visit"><time>{visit.start.slice(11,16)}{visit.end!==visit.start?` — ${visit.end.slice(11,16)}`:''}</time><h3>{visit.name}<small>{visit.photos.length} 张照片</small></h3><div className="album-visit-photos">{visit.photos.slice(0,4).map(p=><button type="button" key={p.id} aria-label={`查看足迹照片 ${p.filename}`} onClick={()=>album.openViewer(p.id,visit.photos.map(q=>q.id))}><img src={p.thumb_url} alt={worldName(p)} loading="lazy"/></button>)}</div>{visit.photos.filter(p=>p.note.trim()).slice(0,3).map(p=><blockquote key={p.id}>{p.note}</blockquote>)}</article>)}</div>{visits.length>limit && <Button variant="secondary" onPress={()=>setLimit(n=>n+24)}>更多足迹</Button>}{!visits.length && <div className="empty"><p>这一天还没有照片记录，可以换个日期看看。</p></div>}</> : <><div className="album-journal-controls"><label className="album-native-field">回顾年份<select aria-label="年度回顾年份" value={year} onChange={e=>setYear(e.target.value)}>{(years.length?years:[year]).map(y=><option key={y} value={y}>{y} 年</option>)}</select></label><Button variant="outline" size="sm" onPress={exportReview}>导出年度回顾</Button></div>
      <div className="album-review-stats">{[[review.members.length,'张照片'],[review.worlds.length,'个世界'],[review.sessions,'场漫游'],[review.days,'个活跃日'],[review.favorites,'张星标']].map(([n,label])=><div key={label}><strong>{n}</strong><span>{label}</span></div>)}</div>
      <h3>每月留下的瞬间</h3><div className="album-month-chart" aria-label="每月照片数量">{review.months.map(m=><div key={m.month} title={`${m.month} 月 ${m.count} 张`}><span>{m.count}</span><div className="album-month-bar" style={{height:`${Math.max(2,m.count/maxMonth*100)}px`}}/><small>{m.month} 月</small></div>)}</div>
      <div className="album-world-ranking"><h3>常去的世界</h3>{review.worlds.slice(0,5).map((w,i)=><p key={`${w.name}:${i}`}><span>{i+1}. {w.name}</span><strong>{w.count} 张</strong></p>)}</div>
      <h3>这一年的精选回忆</h3><p className="discovery-hint">优先选择星标和有备注的照片，同时保留不同世界的足迹。</p><div className="album-highlight-grid">{review.chosen.map(p=><button type="button" key={p.id} aria-label={`查看年度照片 ${p.filename}`} onClick={()=>album.openViewer(p.id,review.members.map(q=>q.id))}><img src={p.thumb_url} alt={worldName(p)} loading="lazy"/><span>{worldName(p)} · {p.date}</span></button>)}</div>{!review.members.length && <div className="empty"><p>这一年还没有照片记录。</p></div>}</>}
    {fallback && <p className="discovery-hint">部分照片日期来自文件修改时间，足迹与统计可能不同于实际拍摄时间。</p>}
  </section>;
}
