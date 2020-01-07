// Modules to control application life and create native browser window
const {app, BrowserWindow, ipcMain} = require('electron')
const storage = require('electron-json-storage');

var c29v = require('./c29v.js');
var verify_c29v = c29v.cwrap('c29v_verify', 'number', ['array','number','array']);
var check_diff = c29v.cwrap('check_diff', 'number', ['number','array']);
var shares=0;
var blocks=0;
var conn=0;

global.poolconfig = { 
	poolport:10000, 
	ctrlport:14651,// use with https://github.com/swap-dev/on-block-notify.git
	daemonport:19281,
	daemonhost:'127.0.0.1',
	mining_address:'XvyVkGmkQvCQvn2DKiie5cBB7y9ZiLJzc4prSuSk6oGu9vJZVNM45LvXEX6uLPSrHVXH62ebDmJCRJQmvdMc9zom8nXCmdzxQp'
};

const http = require('http');
const https = require('https');
const net = require("net");

function seq(){
	var min = 1000000000;
	var max = 2000000000;
	var id = Math.floor(Math.random() * (max - min + 1)) + min;
	return id.toString();
};

function Log() {}
Log.prototype.log = function (level,message) {mainWindow.webContents.send('log', [level,message]);}
Log.prototype.info  = function (message) {this.log('info',message);}
Log.prototype.error = function (message) {this.log('error',message);}
Log.prototype.debug = function (message) {/*this.log('debug',message);*/}
const logger = new Log();

process.on("uncaughtException", function(error) {
	logger.error(error);
});

function jsonHttpRequest(host, port, data, callback, path){
	path = path || '/json_rpc';

	var options = {
		hostname: host,
		port: port,
		path: path,
		method: data ? 'POST' : 'GET',
		headers: {
			'Content-Length': data.length,
			'Content-Type': 'application/json',
			'Accept': 'application/json'
		}
	};

	var req = (port == 443 ? https : http).request(options, function(res){
		var replyData = '';
		res.setEncoding('utf8');
		res.on('data', function(chunk){
			replyData += chunk;
		});
		res.on('end', function(){
			var replyJson;
			try{
				replyJson = JSON.parse(replyData);
			}
			catch(e){
				callback(e);
				return;
			}
			callback(null, replyJson);
		});
	});

	req.on('error', function(e){
		callback(e);
	});

	req.end(data);
}

function rpc(method, params, callback){

	var data = JSON.stringify({
		id: "0",
		jsonrpc: "2.0",
		method: method,
		params: params
	});
	jsonHttpRequest(global.poolconfig.daemonhost, global.poolconfig.daemonport, data, function(error, replyJson){
		if (error){
			callback(error);
			return;
		}
		callback(replyJson.error, replyJson.result)
	});
}

function getBlockTemplate(callback){
	rpc('getblocktemplate', {reserve_size: 0, wallet_address: global.poolconfig.mining_address}, callback);
}

var current_target    = 0;
var current_height    = 1;
var current_blob      = "";
var current_hashblob  = "";
var previous_hashblob = "";
var current_prevhash  = "";
var connectedMiners   = {};
var jobcounter=0;
var blockstxt  = "";
var jobshares=0;

function nonceCheck(miner,nonce) {

	if (miner.nonces.indexOf(nonce) !== -1) return false;

	miner.nonces.push(nonce);

	return true;
}

function hashrate(miner) {

	miner.shares += miner.difficulty|0;

	var hr = miner.shares*16/((Date.now()/1000|0)-miner.begin);

	miner.gps = hr;
	
	var total = 0;
	var workertxt='';

	for (var minerId in connectedMiners){
		var miner2 = connectedMiners[minerId];
		total+=miner2.gps;
		workertxt+=miner2.login+' '+miner2.agent+' '+miner2.pass+' '+miner2.difficulty+' '+miner2.shares+' '+miner2.gps.toFixed(2)+'<br/>';
	}
	mainWindow.webContents.send('workers', workertxt);
	mainWindow.webContents.send('get-reply', ['data_gps',total.toFixed(2)]);

	return 'rig:'+miner.pass+' '+hr.toFixed(2)+' gps';
		
}

function updateJob(reason,callback){

	getBlockTemplate(function(error, result){
		if(error) {
			logger.error(error.message);
			return;
		}

		var previous_hash_buf = Buffer.alloc(32);
		Buffer.from(result.blocktemplate_blob, 'hex').copy(previous_hash_buf,0,7,39);
		var previous_hash = previous_hash_buf.toString('hex');
		

		if(previous_hash != current_prevhash){

			previous_hashblob = current_hashblob;
			
			current_prevhash = previous_hash;
			current_target   = result.difficulty;
			current_blob     = result.blocktemplate_blob;
			current_hashblob = result.blockhashing_blob.slice(0,-16);	
			current_height   = result.height;
			
			jobcounter++;

			logger.info('New block to mine at height '+result.height+' w/ difficulty of '+result.difficulty+' (triggered by: '+reason+')');

			mainWindow.webContents.send('get-reply', ['data_diff',result.difficulty]);
			mainWindow.webContents.send('get-reply', ['data_height',result.height]);
		
			for (var minerId in connectedMiners){
				var miner = connectedMiners[minerId];
				miner.nonces = [];
				var response2 = '{"id":"Stratum","jsonrpc":"2.0","method":"getjobtemplate","result":{"algo":"cuckarood","edgebits":29,"proofsize":32,"noncebytes":4,"difficulty":'+miner.difficulty+',"height":'+current_height+',"job_id":'+seq()+',"pre_pow":"'+current_hashblob+miner.nextnonce()+'"},"error":null}';
				miner.socket.write(response2+"\n");
			}
		}
		if(callback) callback();
	});
}

function Miner(id,socket){
	this.socket = socket;
	this.login = '';
	this.pass = '';
	this.agent = '';
	this.jobnonce = '';
	this.oldnonce = '';
	this.begin = Date.now()/1000|0;
	this.shares = 0;
	this.gps = 0;
	this.difficulty = 1;
	this.id = id;
	this.nonces = [];
	
	var client = this;
	
	socket.on('data', function(input) {
		try{
			for (var data of input.toString().trim().split("\n"))
				handleClient(data,client);
		}
		catch(e){
			logger.error("error: "+e+" on data: "+input);
			socket.end();
		}
	});
	
	socket.on('close', function(had_error) {
		logger.info('miner connction dropped '+client.login);
		mainWindow.webContents.send('get-reply', ['data_conn',--conn]);
		delete connectedMiners[client.id];
		var total=0;
		var workertxt='';
		for (var minerId in connectedMiners){
			var miner2 = connectedMiners[minerId];
			total+=miner2.gps;
			workertxt+=miner2.login+' '+miner2.agent+' '+miner2.pass+' '+miner2.difficulty+' '+miner2.shares+' '+miner2.gps.toFixed(2)+'<br/>';
		}
		mainWindow.webContents.send('workers', workertxt);
		mainWindow.webContents.send('get-reply', ['data_gps',total.toFixed(2)]);
		socket.end();
	});

	socket.on('error', function(had_error) {
		socket.end();
	});
}
Miner.prototype.respose = function (result,error,request) {
	
	var response = JSON.stringify({
			id:request.id.toString(),
			jsonrpc:"2.0",
			method:request.method,
			result: (result?result:null),
			error: (error?error:null)
	});
	logger.debug("p->m "+response);
	this.socket.write(response+"\n");
}

Miner.prototype.nextnonce = function () {

	this.oldnonce = this.jobnonce;
	
	var noncebuffer = Buffer.allocUnsafe(4);
	noncebuffer.writeUInt32BE(++jobcounter,0);
	this.jobnonce = noncebuffer.reverse().toString('hex')+'00000000';
	
	return this.jobnonce;
}
	
function handleClient(data,miner){
	
	logger.debug("m->p "+data);

	var request = JSON.parse(data.replace(/([0-9]{15,30})/g, '"$1"'));//puts all long numbers in quotes, js can't handle 64bit ints

	var response;

	if(request && request.method && request.method == "login") {

		miner.login=request.params.login;
		miner.pass =request.params.pass;
		miner.agent =request.params.agent;
		var fixedDiff = miner.login.indexOf('.');
		if(fixedDiff != -1) {
			miner.difficulty = miner.login.substr(fixedDiff + 1);
			if(miner.difficulty < 1) miner.difficulty = 1;
			if(isNaN(miner.difficulty)) miner.difficulty = 1;
			miner.login = miner.login.substr(0, fixedDiff);
		}
		logger.info('miner connect '+request.params.login+' ('+request.params.agent+') ('+miner.difficulty+')');
		
		var workertxt='';
		for (var minerId in connectedMiners){
			var miner2 = connectedMiners[minerId];
			workertxt+=miner2.login+' '+miner2.agent+' '+miner2.pass+' '+miner2.difficulty+' '+miner2.shares+' '+miner2.gps.toFixed(2)+'<br/>';
		}
		mainWindow.webContents.send('workers', workertxt);
		return miner.respose('ok',null,request);
	}
	
	if(request && request.method && request.method == "submit") {

		if(!request.params || !request.params.pow || !request.params.nonce || request.params.pow.length != 32) {

			logger.info('bad data ('+miner.login+')');
			return miner.respose(null,{code: -32502, message: "wrong hash"},request);
		}
		
		if(! nonceCheck(miner,request.params.pow.join('.'))) {
		
			logger.info('duplicate ('+miner.login+')');
			return miner.respose(null,{code: -32503, message: "duplicate"},request);
		}
		
		var cycle = Buffer.allocUnsafe(request.params.pow.length*4);
		for(var i in request.params.pow)
		{
			cycle.writeUInt32LE(request.params.pow[i], i*4);
		}
		var noncebuffer = Buffer.allocUnsafe(4);
		noncebuffer.writeUInt32BE(request.params.nonce,0);
		var header = Buffer.concat([Buffer.from(current_hashblob, 'hex'),Buffer.from(miner.jobnonce,'hex'),noncebuffer]);
			
		if(verify_c29v(header,header.length,cycle)){

			var header_previous = Buffer.concat([Buffer.from(previous_hashblob, 'hex'),Buffer.from(miner.oldnonce,'hex'),noncebuffer]);
			
			if(verify_c29v(header_previous,header_previous.length,cycle)){
			
				logger.info('wrong hash or very old ('+miner.login+') '+request.params.height);
				return miner.respose(null,{code: -32502, message: "wrong hash"},request);
			}
			else{

				logger.info('stale ('+miner.login+')');
				return miner.respose('stale',null,request);
			}
		}
		
		if(check_diff(current_target,cycle)) {
			
			var block = Buffer.from(current_blob, 'hex');

			for(var i in request.params.pow)
			{
				block.writeUInt32LE(request.params.pow[i], 51+(i*4));
			}
			block.writeUInt32LE(request.params.nonce,47);
			Buffer.from(miner.jobnonce, 'hex').copy(block,39,0,8);

			rpc('submitblock', [block.toString('hex')], function(error, result){
				logger.info('BLOCK ('+miner.login+')');
				updateJob('found block');
				blocks++;
				mainWindow.webContents.send('get-reply', ['data_blocks',blocks]);
				blockstxt+=(current_height-1)+' '+((jobshares/current_target*100).toFixed(2))+'%<br/>';
				jobshares=0;
				mainWindow.webContents.send('blocks', blockstxt);
			});
		}
		
		if(check_diff(miner.difficulty,cycle)) {
		
			shares+=parseFloat(miner.difficulty);
			jobshares+=parseFloat(miner.difficulty);
			mainWindow.webContents.send('get-reply', ['data_shares',shares+' ('+(jobshares/current_target*100).toFixed(2)+'%)']);
				
			logger.info('share ('+miner.login+') '+miner.difficulty+' ('+hashrate(miner)+')');
			return miner.respose('ok',null,request);
		}
		else{

			logger.info('low diff ('+miner.login+') '+miner.difficulty);
			return miner.respose(null,{code: -32501, message: "low diff"},request);
		}
		
	}
	
	if(request && request.method && request.method == "getjobtemplate") {
		
		return miner.respose({algo:"cuckarood",edgebits:29,proofsize:32,noncebytes:4,difficulty:parseFloat(miner.difficulty),height:current_height,job_id:seq(),pre_pow:current_hashblob+miner.nextnonce()},null,request);
	}
	else{

		logger.info("unkonwn method: "+request.method);
	}

}

var ctrl_server = net.createServer(function (localsocket) {
    updateJob('ctrlport');
});
ctrl_server.listen(global.poolconfig.ctrlport,'127.0.0.1');

var server = net.createServer(function (localsocket) {
	var minerId = seq();
	var miner = new Miner(minerId,localsocket);
	mainWindow.webContents.send('get-reply', ['data_conn',++conn]);
	connectedMiners[minerId] = miner;
	
});

server.timeout = 0;

let mainWindow;

function createWindow () {
	// Create the browser window.
	mainWindow = new BrowserWindow({
		title: 'MoneroV Micropool',
		width: 800,
		height: 600,
		minWidth: 800,
		minHeight: 310,
		icon: __dirname + '/build/icon_small.png'
	})

	mainWindow.setMenu(null);

	mainWindow.loadFile('index.html');

	ipcMain.on('set',(event,arg) => {

		if(arg[0] === "mining_address") global.poolconfig.mining_address=arg[1];
		if(arg[0] === "daemonport") global.poolconfig.daemonport=arg[1];
		if(arg[0] === "daemonhost") global.poolconfig.daemonhost=arg[1];
		if(arg[0] === "poolport") global.poolconfig.poolport=arg[1];

		storage.set(arg[0],arg[1]);
	});


	var count=0;

	ipcMain.on('get',(event,arg) => {
		var sender = event.sender;
		var arg0 = arg;
		storage.has(arg0,function(error,haskey) {
			if(error || !haskey)
			{
				if(arg0 === "mining_address") sender.send('get-reply', [arg0,global.poolconfig.mining_address]);
				if(arg0 === "daemonport") sender.send('get-reply', [arg0,global.poolconfig.daemonport]);
				if(arg0 === "daemonhost") sender.send('get-reply', [arg0,global.poolconfig.daemonhost]);
				if(arg0 === "poolport") sender.send('get-reply', [arg0,global.poolconfig.poolport]);
				if(arg0 === "mining_address") storage.set(arg0,global.poolconfig.mining_address);
				if(arg0 === "daemonport") storage.set(arg0,global.poolconfig.daemonport);
				if(arg0 === "daemonhost") storage.set(arg0,global.poolconfig.daemonhost);
				if(arg0 === "poolport") storage.set(global.poolconfig.poolport);
				count++;
				if(count == 4) {
					updateJob('init',function(){
						server.listen(global.poolconfig.poolport,'0.0.0.0');
						logger.info("start monerov micropool, port "+global.poolconfig.poolport);
					});
					setInterval(function(){updateJob('timer');}, 100);
				}
			}
			if(!error && haskey)
				storage.get(arg0,function(error,object) {
					if(!error) sender.send('get-reply', [arg0,object]);
					if(arg0 === "mining_address") global.poolconfig.mining_address=object;
					if(arg0 === "daemonport") global.poolconfig.daemonport=object;
					if(arg0 === "daemonhost") global.poolconfig.daemonhost=object;
					if(arg0 === "poolport") global.poolconfig.poolport=object;
					count++;
					if(count == 4) {
						updateJob('init',function(){
							server.listen(global.poolconfig.poolport,'0.0.0.0');
							logger.info("start monerov micropool, port "+global.poolconfig.poolport);
						});
						setInterval(function(){updateJob('timer');}, 100);
					}
				});
		});
	});

	//mainWindow.webContents.openDevTools()

	mainWindow.on('closed', function () {
		mainWindow = null
	})
}

app.on('ready', createWindow)

app.on('window-all-closed', function () {
	if (process.platform !== 'darwin') {
		app.quit()
	}
})

app.on('activate', function () {
	if (mainWindow === null) {
		createWindow()
	}
})
