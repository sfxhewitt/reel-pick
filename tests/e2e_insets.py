"""iPhone 17 Pro Max standalone emulation: 62px top / 34px bottom safe-area insets with tap-swallowing overlays."""
STANDALONE_CSS = """:root{--top:62px!important;--bot:34px!important}
#__sb{position:fixed;left:0;right:0;top:0;height:62px;z-index:2147483647;background:rgba(255,0,128,.18);pointer-events:auto}
#__sb i{position:absolute;left:50%;top:11px;width:126px;height:37px;margin-left:-63px;border-radius:20px;background:#000}
#__hi{position:fixed;left:0;right:0;bottom:0;height:34px;z-index:2147483647;background:rgba(255,0,128,.12);pointer-events:auto}
#__hi i{position:absolute;left:50%;bottom:8px;width:140px;height:5px;margin-left:-70px;border-radius:3px;background:#fff}"""
INSET_JS = "(css)=>{const add=()=>{if(document.getElementById('__sb'))return;const s=document.createElement('style');s.textContent=css;document.head.appendChild(s);" \
           "for(const id of ['__sb','__hi']){const d=document.createElement('div');d.id=id;d.innerHTML='<i></i>';document.body.appendChild(d);}};" \
           "document.readyState==='loading'?document.addEventListener('DOMContentLoaded',add):add();}"
