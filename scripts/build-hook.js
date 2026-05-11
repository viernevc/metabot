import fs from 'node:fs';

function main() {
    fs.cpSync('src/memory/static','dist/memory/static',{
        recursive:true
    });
}

main();
