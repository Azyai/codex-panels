#!/usr/bin/env python3
"""给官方 Codex 扩展的 webview 打「会话列表轮询 + 项目筛选」补丁 v4。

注入点:listRecentThreads(会话列表必经的数据获取方法,首次调用即启动全部逻辑)。
注入内容:
  1. 1 秒原生轮询(refreshRecentConversations,mode='cp-sync' 绕过 catalog 闸门)
  2. listRecentThreads 结果过滤:按「当前项目 / 其他项目 / 普通会话」三类多选显隐
  3. 头部筛选按钮:运行时克隆官方 New chat 按钮的样式类,插进同一容器(不遮挡原按钮);
     点击弹出下拉多选菜单(复选框),选项即时生效
  4. 从 codex-panels 后端(8391)取工作区根目录与项目归属表

用法:python patch-webview-poll.py <webview目录>\\assets
"""
import os
import sys

TARGET = 'async listRecentThreads({originators:e,cursor:t,limit:n,background:r=!1}){'

INJECT = r"""if(!this.__cpSync){this.__cpSync=1;try{
var __cpStore=this;
var __cpW=window;
__cpW.__cpOn=__cpW.__cpOn||{current:1,other:1,plain:1};
__cpW.__cpRoot='';
__cpW.__cpProjects=[];
__cpW.__cpAssign={};
var __cpNorm=function(p){return String(p||'').toLowerCase().replace(/\\/g,'/').replace(/\/+$/,'')};
var __cpFetch=function(u){return fetch('http://127.0.0.1:8391'+u).then(function(r){return r.ok?r.json():null}).catch(function(){return null})};
var __cpMeta=function(){
__cpFetch('/workspace-root').then(function(d){if(d&&d.root)__cpW.__cpRoot=d.root});
__cpFetch('/projects').then(function(d){if(d){__cpW.__cpProjects=d.projects||[];__cpW.__cpAssign=d.assignments||{}}});
};
__cpMeta();setInterval(__cpMeta,10000);
var __cpOrig=this.listRecentThreads.bind(this);
this.listRecentThreads=async function(opts){
var result=await __cpOrig(opts);
try{
var on=__cpW.__cpOn;
if(!(on.current&&on.other&&on.plain)&&result&&result.data&&result.data.length){
var root=__cpNorm(__cpW.__cpRoot);
var pmap={};
(__cpW.__cpProjects||[]).forEach(function(p){(p.rootPaths||[]).forEach(function(rp){pmap[__cpNorm(rp)]=p.id})});
result.data=result.data.filter(function(t){
var c=__cpNorm(t.cwd);
if(root&&c===root)return !!on.current;
var a=__cpW.__cpAssign[t.id];
if(a&&a.projectId){
var isCur=false;
for(var k in pmap){if(pmap[k]===a.projectId&&k===root){isCur=true;break}}
return isCur?!!on.current:!!on.other;
}
if(pmap[c])return !!on.other;
return !!on.plain;
});
}
}catch(e){}
return result;
};
var __cpSVG='<svg aria-hidden="true" fill="currentColor" height="16" viewBox="0 0 16 16" width="16" xmlns="http://www.w3.org/2000/svg"><path d="M1.75 2.5h12.5a.75.75 0 0 1 0 1.5H1.75a.75.75 0 0 1 0-1.5Zm2 4h8.5a.75.75 0 0 1 0 1.5h-8.5a.75.75 0 0 1 0-1.5Zm2 4h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1 0-1.5Z"/></svg>';
var __cpRemoveMenu=function(){
var m=document.getElementById('cp-filter-menu');
if(m)m.remove();
document.removeEventListener('mousedown',__cpCloser,true);
};
var __cpCloser=function(ev){
var m=document.getElementById('cp-filter-menu');
if(!m){document.removeEventListener('mousedown',__cpCloser,true);return}
if(m.contains(ev.target))return;
if(ev.target&&ev.target.closest&&ev.target.closest('#cp-filter-btn'))return;
__cpRemoveMenu();
};
var __cpMenu=function(btn){
if(document.getElementById('cp-filter-menu')){__cpRemoveMenu();return}
var m=document.createElement('div');
m.id='cp-filter-menu';
var r=btn.getBoundingClientRect();
var s=m.style;
s.position='fixed';
s.top=(r.bottom+6)+'px';
s.right=Math.max(2,window.innerWidth-r.right)+'px';
s.zIndex='100000';
s.minWidth='176px';
s.background='#1f1f1f';
s.border='1px solid #454545';
s.borderRadius='6px';
s.boxShadow='0 4px 16px rgba(0,0,0,.45)';
s.padding='4px';
s.fontSize='12px';
s.color='#cccccc';
s.fontFamily='inherit';
var head=document.createElement('div');
head.textContent='会话筛选';
head.style.cssText='padding:4px 8px 6px;font-size:10px;letter-spacing:.05em;color:#8b8b8b;text-transform:uppercase';
m.appendChild(head);
var OPTS=[['current','当前项目会话'],['other','其他项目会话'],['plain','普通会话']];
OPTS.forEach(function(o){
var row=document.createElement('div');
row.style.cssText='display:flex;align-items:center;gap:8px;padding:4px 8px;border-radius:4px;cursor:pointer;user-select:none';
row.onmouseenter=function(){row.style.background='#2a2d2e'};
row.onmouseleave=function(){row.style.background='transparent'};
var box=document.createElement('span');
box.style.cssText='width:14px;height:14px;flex:0 0 14px;border:1px solid #6b6b6b;border-radius:3px;display:inline-flex;align-items:center;justify-content:center;font-size:10px;line-height:1';
var label=document.createElement('span');
label.textContent=o[1];
var sync=function(){
var v=!!__cpW.__cpOn[o[0]];
box.style.background=v?'#3794ff':'transparent';
box.style.borderColor=v?'#3794ff':'#6b6b6b';
box.style.color='#fff';
box.textContent=v?'\u2713':'';
row.style.opacity=v?'1':'.6';
};
row.onclick=function(ev){
ev.stopPropagation();
__cpW.__cpOn[o[0]]=__cpW.__cpOn[o[0]]?0:1;
sync();
__cpBadge();
try{__cpStore.refreshRecentConversations({mode:'cp-sync'}).catch(function(){})}catch(e){}
};
sync();
row.appendChild(box);
row.appendChild(label);
m.appendChild(row);
});
document.body.appendChild(m);
setTimeout(function(){document.addEventListener('mousedown',__cpCloser,true)},0);
};
var __cpBadge=function(){
var b=document.getElementById('cp-filter-btn');
if(!b)return;
var on=__cpW.__cpOn;
b.style.color=(on.current&&on.other&&on.plain)?'':'#3794ff';
};
var __cpMount=function(){
var b=document.getElementById('cp-filter-btn');
if(b){__cpBadge();return}
var anchor=null;
var bs=document.querySelectorAll('button');
for(var i=0;i<bs.length;i++){
var x=bs[i],t=(x.getAttribute('aria-label')||'')+' '+(x.title||'');
if(/new chat|新聊天/i.test(t)){anchor=x;break}
}
if(!anchor||!anchor.parentElement)return;
b=document.createElement('button');
b.id='cp-filter-btn';
b.type='button';
b.title='筛选会话列表';
b.setAttribute('aria-label','筛选会话列表');
b.className=anchor.className;
b.innerHTML=__cpSVG;
b.onclick=function(ev){ev.stopPropagation();ev.preventDefault();__cpMenu(b)};
anchor.parentElement.insertBefore(b,anchor);
__cpBadge();
};
setInterval(function(){try{__cpMount()}catch(e){}},2000);
__cpMount();
setInterval(function(){try{__cpStore.refreshRecentConversations({mode:'cp-sync'}).catch(function(){})}catch(e){}},1000);
}catch(e){}}"""


def patch_file(path):
    data = open(path, encoding='utf-8', errors='surrogatepass').read()
    if '__cpSync' in data:
        print('已打过补丁:', os.path.basename(path))
        return False
    idx = data.find(TARGET)
    if idx < 0:
        return False
    patched = data[: idx + len(TARGET)] + INJECT + data[idx + len(TARGET):]
    backup = path + '.orig-poll'
    if not os.path.exists(backup):
        with open(path, 'rb') as src, open(backup, 'wb') as dst:
            dst.write(src.read())
    # newline='' 禁止 \n→\r\n 转换:保持与原文件一致的 LF 行尾,
    # 否则整个 7.5MB 文件被改写行尾后,webview 的 V8 会解析失败
    with open(path, 'w', encoding='utf-8', errors='surrogatepass', newline='') as f:
        f.write(patched)
    print('已注入轮询+筛选补丁 v4:', os.path.basename(path))
    return True


def main():
    assets_dir = sys.argv[1]
    patched = 0
    for name in os.listdir(assets_dir):
        if name.endswith('.js'):
            if patch_file(os.path.join(assets_dir, name)):
                patched += 1
    if patched == 0:
        print('未找到可打补丁的文件(或均已打过)')
        sys.exit(1)


if __name__ == '__main__':
    main()
