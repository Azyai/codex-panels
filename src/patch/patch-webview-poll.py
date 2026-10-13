#!/usr/bin/env python3
"""给官方 Codex 扩展的 webview 打「会话列表轮询 + 项目筛选」补丁 v3。

注入点:listRecentThreads(会话列表必经的数据获取方法,首次调用即启动全部逻辑)。
注入内容:
  1. 1 秒原生轮询(refreshRecentConversations,mode='cp-sync' 绕过 catalog 闸门)
  2. listRecentThreads 结果过滤:当前项目 / 所有项目 / 普通对话(无项目归属)
  3. 面板右上角筛选按钮(纯 DOM,React 重渲染后自动补挂)
  4. 从 codex-panels 后端(8391)取工作区根目录与项目归属表

用法:python patch-webview-poll.py <webview目录>\\assets
"""
import os
import sys

TARGET = 'async listRecentThreads({originators:e,cursor:t,limit:n,background:r=!1}){'

INJECT = r"""if(!this.__cpSync){this.__cpSync=1;try{
var __cpStore=this;
var __cpW=window;
__cpW.__cpFilter=__cpW.__cpFilter||'all';
__cpW.__cpRoot='';
__cpW.__cpAssign={};
var __cpMODES=[['all','所有项目'],['current','当前项目'],['plain','普通对话']];
var __cpFetch=function(u){return fetch('http://127.0.0.1:8391'+u).then(function(r){return r.ok?r.json():null}).catch(function(){return null})};
var __cpMeta=function(){
__cpFetch('/workspace-root').then(function(d){if(d&&d.root)__cpW.__cpRoot=d.root});
__cpFetch('/projects').then(function(d){if(d)__cpW.__cpAssign=d.assignments||{}});
};
__cpMeta();setInterval(__cpMeta,10000);
var __cpOrig=this.listRecentThreads.bind(this);
this.listRecentThreads=async function(opts){
var result=await __cpOrig(opts);
try{
if(__cpW.__cpFilter==='current'&&__cpW.__cpRoot&&result&&result.data){
var __r=String(__cpW.__cpRoot).toLowerCase().replace(/\\/g,'/');
result.data=result.data.filter(function(t){return String(t.cwd||'').toLowerCase().replace(/\\/g,'/')===__r});
}else if(__cpW.__cpFilter==='plain'&&result&&result.data){
result.data=result.data.filter(function(t){return !__cpW.__cpAssign[t.id]});
}
}catch(e){}
return result;
};
var __cpMount=function(){
var b=document.getElementById('cp-filter-btn');
if(b){
b.textContent='▦ '+(__cpMODES.find(function(m){return m[0]===__cpW.__cpFilter})||__cpMODES[0])[1];
return;
}
b=document.createElement('div');
b.id='cp-filter-btn';
b.textContent='▦ '+(__cpMODES.find(function(m){return m[0]===__cpW.__cpFilter})||__cpMODES[0])[1];
b.title='筛选会话列表(点击切换)';
var s=b.style;
s.position='fixed';s.top='6px';s.right='8px';s.zIndex='99999';
s.padding='3px 10px';s.borderRadius='6px';s.cursor='pointer';
s.fontSize='11px';s.fontFamily='system-ui,sans-serif';
s.background='rgba(55,55,65,0.88)';s.color='#d8d8dc';s.border='1px solid rgba(255,255,255,0.14)';
b.onclick=function(ev){
ev.stopPropagation();
var i=__cpMODES.findIndex(function(m){return m[0]===__cpW.__cpFilter});
__cpW.__cpFilter=__cpMODES[(i+1)%__cpMODES.length][0];
b.textContent='▦ '+(__cpMODES.find(function(m){return m[0]===__cpW.__cpFilter}))[1];
try{__cpStore.refreshRecentConversations({mode:'cp-sync'}).catch(function(){})}catch(e){}
};
(document.body||document.documentElement).appendChild(b);
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
    open(path, 'w', encoding='utf-8', errors='surrogatepass').write(patched)
    print('已注入轮询+筛选补丁 v3:', os.path.basename(path))
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
