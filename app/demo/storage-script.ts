/**
 * Inline script for the demo build's <head>: replaces `localStorage` and
 * `sessionStorage` with objects that live in memory, before any module runs.
 *
 * The app keeps small preferences in browser storage (theme, last mailbox,
 * hidden mailboxes, dismissed notices). In the demo nothing may outlive the
 * page, so a reload always starts from the same state.
 *
 * It also reserves the height of the demo notice (DemoBanner.tsx) above the
 * top bar, so the page does not shift when the notice renders.
 */
export const demoStorageScript = `(function(){
function mem(){var m=new Map();return{
getItem:function(k){k=String(k);return m.has(k)?m.get(k):null},
setItem:function(k,v){m.set(String(k),String(v))},
removeItem:function(k){m.delete(String(k))},
clear:function(){m.clear()},
key:function(i){return Array.from(m.keys())[i]||null},
get length(){return m.size}}}
try{Object.defineProperty(window,"localStorage",{value:mem(),configurable:true});
Object.defineProperty(window,"sessionStorage",{value:mem(),configurable:true})}catch(e){}
document.documentElement.setAttribute("data-demo","");
document.documentElement.style.setProperty("--app-notice-h","2rem");
})();`;
