import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { cpSync, mkdirSync, existsSync, readFileSync } from 'node:fs';

export default defineConfig({
  base: '/zhejiang-physics-bank/',
  plugins: [{
    // Page descriptions quote the bank size; derive it from the published catalog.
    name: 'bank-summary',
    transformIndexHtml(html) {
      const catalog=JSON.parse(readFileSync('public/data/catalog.json','utf8'));
      const questions=catalog.papers.reduce((s:number,p:{question_count:number})=>s+p.question_count,0);
      return html.replaceAll('__BANK_SUMMARY__',`${catalog.papers.length}卷${questions}题`);
    }
  },{
    name: 'local-mathjax',
    configureServer(server) {
      server.middlewares.use('/zhejiang-physics-bank/vendor/mathjax', (req,res,next)=>{
        const relative=(req.url||'').split('?')[0].replace(/^\//,'');
        if(!/^[a-zA-Z0-9_./-]+\.js$/.test(relative)||relative.split('/').includes('..'))return next();
        const file=resolve('node_modules/mathjax/es5',relative);
        if(!existsSync(file))return next();res.setHeader('Content-Type','text/javascript');res.end(readFileSync(file));
      });
    },
    closeBundle() {
      mkdirSync('dist/vendor/mathjax', {recursive:true});
      // All extensions stay local; only SVG output is used, so no webfont fetches.
      cpSync('node_modules/mathjax/es5', 'dist/vendor/mathjax', {recursive:true});
      cpSync('node_modules/mathjax/LICENSE', 'dist/vendor/mathjax/LICENSE');
    }
  }],
  build: {rollupOptions:{input:Object.fromEntries(['index','paper','question','worksheet','about'].map(n=>[n,resolve(process.cwd(),n+'.html')]))}}
});
