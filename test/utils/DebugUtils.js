const print = result => {
    if (process.env.DEBUG_LOG) {
        if(typeof result === 'string') {
            console.log(result);
        }
        else {
            Object.keys(result).filter(key => isNaN(key)).forEach(key => console.log(key, result[key].toString()));
        }
    }
};

exports.print = print;
