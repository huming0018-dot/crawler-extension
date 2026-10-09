(function(root){
  'use strict';
  function target(value) {
    const u=new URL(String(value).trim());
    if(u.protocol!=='https:'||u.username||u.password||u.port)throw Error('请使用平台的 HTTPS 主页或内容链接');
    let m,platform,kind,id;
    if(['www.xiaohongshu.com','m.xiaohongshu.com'].includes(u.hostname)){
      platform='xiaohongshu';
      if((m=u.pathname.match(/^\/user\/profile\/([a-f0-9]{24})\/?$/i))){kind='creator';id=m[1].toLowerCase();}
      else if((m=u.pathname.match(/^\/(?:explore|discovery\/item)\/([a-f0-9]{24})\/?$/i))){kind='content';id=m[1].toLowerCase();}
    }else if(u.hostname==='space.bilibili.com'&&(m=u.pathname.match(/^\/(\d+)\/?(?:video)?\/?$/))){platform='bilibili';kind='creator';id=m[1];}
    else if(u.hostname==='www.bilibili.com'&&(m=u.pathname.match(/^\/video\/(BV[A-Za-z0-9]{10})\/?$/))){platform='bilibili';kind='content';id=m[1];}
    if(!id)throw Error('暂支持小红书主页/笔记、B站空间/BV视频的完整链接');
    const canonical_url=platform==='xiaohongshu'?'https://www.xiaohongshu.com/'+(kind==='creator'?'user/profile/':'explore/')+id:
      kind==='creator'?'https://space.bilibili.com/'+id:'https://www.bilibili.com/video/'+id;
    return {platform,kind,id,canonical_url,local_url:u.href};
  }
  function csv(text){
    if(typeof text!=='string'||text.length>100000)throw Error('CSV上限100KB');
    const rows=[];let row=[],cell='',quote=false;
    text=text.replace(/^\uFEFF/,'');
    for(let i=0;i<text.length;i++){
      const c=text[i];
      if(quote){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++;}else quote=false;}else cell+=c;}
      else if(c==='"'){if(cell)throw Error('CSV引号格式错误');quote=true;}
      else if(c===','){row.push(cell);cell='';}
      else if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);if(row.some(x=>x.trim()))rows.push(row);row=[];cell='';}
      else cell+=c;
    }
    if(quote)throw Error('CSV引号未闭合');
    row.push(cell);if(row.some(x=>x.trim()))rows.push(row);
    if(!rows.length)return [];
    const header=rows.shift().map(x=>x.trim().toLowerCase());
    const allowed=['platform','profile_url','url','display_name','alias','group'];
    if(header.some(x=>!allowed.includes(x))||new Set(header).size!==header.length||!header.some(x=>['profile_url','url'].includes(x)))throw Error('CSV列只允许platform、profile_url、display_name、group（可用url、alias别名）');
    if(rows.length>100)throw Error('单次最多100个目标');
    const seen=new Set();
    return rows.map((values,i)=>{
      const result={row:i+2,status:'valid'};
      try{
        if(values.length!==header.length)throw Error('列数不一致');
        const r=Object.fromEntries(header.map((h,j)=>[h,values[j].trim()]));
        const t=target(r.profile_url||r.url);
        if(r.platform&&r.platform!==t.platform)throw Error('平台与链接不一致');
        Object.assign(result,t,{display_name:r.display_name||r.alias||'',group:r.group||''});
        const key=t.platform+':'+t.kind+':'+t.id;
        if(seen.has(key))result.status='duplicate';seen.add(key);
      }catch(e){result.status='invalid';result.error=e.message;}
      return result;
    });
  }
  function csvExport(rows){
    const esc=x=>{let s=x==null?'':typeof x==='object'?JSON.stringify(x):String(x);if(/^[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
    const keys=[...new Set(rows.flatMap(r=>Object.keys(r)))];
    return '\uFEFF'+[keys.map(esc).join(','),...rows.map(r=>keys.map(k=>esc(r[k])).join(','))].join('\r\n');
  }
  function qualitySummary(rows){
    rows=Array.isArray(rows)?rows:[];
    const keys=['title','body','creator_id','published_at','like_count','collect_count','comment_count','view_count','share_count','danmaku_count'];
    const summarize=items=>Object.fromEntries(keys.map(key=>{
      const values=items.map(item=>({value:item[key]??item.metrics?.[key],status:(item.field_observations||item.metrics?.observations)?.[key]?.status}));
      const available=values.filter(x=>x.value!=null&&(typeof x.value!=='string'||x.value.trim().length>0)).length;
      return [key,{available,missing:items.length-available,rate:items.length?available/items.length:null,approximate:values.filter(x=>x.status==='approximate').length}];
    }));
    const platforms=Object.create(null);for(const item of rows){const p=item.platform||'unknown';(platforms[p]??=[]).push(item);}
    const sampling={requested_contents:0,observed_comments:0,observed_replies:0,source_reported_contents:0,source_reported_comments:0,source_reported_approximate_contents:0,source_coverage:'unknown'};
    for(const item of rows){const comments=item.comments;if(!comments)continue;
      if(comments.status==='not_requested')continue;
      const items=Array.isArray(comments)?comments:Array.isArray(comments.items)?comments.items:[];
      sampling.requested_contents++;sampling.observed_comments+=items.length;sampling.observed_replies+=items.filter(x=>x.is_reply||x.parent_key).length;
      const reported=item.metrics?.comment_count;if(Number.isFinite(reported)&&reported>=0){sampling.source_reported_contents++;sampling.source_reported_comments+=reported;if(item.metrics?.observations?.comment_count?.status==='approximate')sampling.source_reported_approximate_contents++;}
    }
    return {schema_version:1,scope:'exported_contents_only',total:rows.length,fields:summarize(rows),by_platform:Object.fromEntries(Object.entries(platforms).map(([p,items])=>[p,{total:items.length,fields:summarize(items)}])),comment_sampling:sampling,
      caveats:['只统计当前导出记录，不代表账号、平台或全部历史内容。','字段可用率不等于准确率；不适用字段也可能为空，请按平台查看。','评论为已加载样本；源站报告可能近似且包含回复，不能由两者比值推断召回率。','目标由用户选择，可能存在选择、时间窗口和可见性偏差；没有总体基准，未估计统计偏差量。']};
  }
  root.CrowdKOLUI={target,csv,csvExport,qualitySummary};
})(globalThis);
