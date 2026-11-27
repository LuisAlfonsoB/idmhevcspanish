'use strict';
// Search engines taken from the Android app's Constants / suggestion tasks.
const ENGINES = {
  google:     { name: 'Google',      url: 'https://www.google.com/search?client=lightning&ie=UTF-8&oe=UTF-8&q=', suggest: 'https://suggestqueries.google.com/complete/search?client=chrome&q=' },
  duckduckgo: { name: 'DuckDuckGo',  url: 'https://duckduckgo.com/?t=lightning&q=', suggest: 'https://duckduckgo.com/ac/?type=list&q=' },
  bing:       { name: 'Bing',        url: 'https://www.bing.com/search?q=', suggest: 'https://api.bing.com/osjson.aspx?query=' },
  brave:      { name: 'Brave',       url: 'https://search.brave.com/search?source=web&q=', suggest: 'https://search.brave.com/api/suggest?q=' },
  startpage:  { name: 'Startpage',   url: 'https://startpage.com/do/search?language=english&query=' },
  yahoo:      { name: 'Yahoo',       url: 'https://search.yahoo.com/search?ei=UTF-8&p=', suggest: 'https://ca.search.yahoo.com/sugg/ff?output=fxjson&command=' },
  ask:        { name: 'Ask',         url: 'http://www.ask.com/web?qsrc=0&o=0&l=dir&qo=LightningBrowser&q=' },
  aol:        { name: 'AOL',         url: 'https://search.aol.com/aol/search?q=' },
  baidu:      { name: 'Baidu',       url: 'https://www.baidu.com/s?wd=' },
  yandex:     { name: 'Yandex',      url: 'https://yandex.com/search/?text=' }
};
module.exports = { ENGINES };
