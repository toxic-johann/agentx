'use strict';

var os = require('os');
var fs = require('fs');
var path = require('path');

var lastTotal = 0;
var lastIdle = 0;

/*
*      user  nice system idle    iowait irq  softirq steal guest  guest_nice
* cpu  74608 2520 24433  1117073 6176   4054 0       0     0      0
*
* Idle = idle + iowait + steal
* NonIdle = user + nice + system + irq + softirq + steal
* Total = Idle + NonIdle;
* cpu% = 1 - diffIdle / diffTotal
* this is a description for "steal", it is useful in a VM env.
* http://blog.scoutapp.com/articles/2013/07/25/understanding-cpu-steal-time-when-should-you-be-worried
*/
var calculateLinuxCPU = function () {
  var raw = fs.readFileSync('/proc/stat');
  if (!raw) {
    return 0;
  }

  var lines = raw.toString().trim().split('\n');
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('cpu ') >= 0) {
      var stat = lines[i].split(' ');
      // [ 'cpu', '', '327248', '602', '82615', '1556436',
      //              '22886', '0', '134', '0', '0', '0' ]
      stat.shift();
      stat.shift();
      var idle = parseInt(stat[3], 10) +
          parseInt(stat[4], 10) + parseInt(stat[7], 10);
      var total = 0;
      for (var j = 0; j < 8; j++) {
        total += parseInt(stat[j], 10);
      }
      var diffTotal = total - lastTotal;
      var diffIdle = idle - lastIdle;
      lastTotal = total;
      lastIdle = idle;
      return 1 - diffIdle / diffTotal;
    }
  }
  return 0;
};


var isInDocker = function () {
  try{
    var raw = fs.readFileSync('/proc/self/cgroup', 'utf8').trim().split('\n');
    for (var i = 0; i < raw.length; i++) {
      if (raw[i].indexOf('device') >= 0 || raw[i].indexOf('cpu') >= 0) {
        var one = raw[i].split(':');
        if (one[2].indexOf('/docker/') === 0) {
          return true;
        }
      }
    }
    return false;
  } catch (err) {
    return false;
  }
}

/*
  returns the allocated cpu count, if not spicified when start container,
  container can use cpu as much as the host's cpu resource.
*/
var _getDockerCPUs = function () {
  const def_cpu = os.cpus().length;
  if (os.type() !== 'Linux') {
    return def_cpu;
  }
  const period_path = '/sys/fs/cgroup/cpu/cpu.cfs_period_us';
  const quota_path = '/sys/fs/cgroup/cpu/cpu.cfs_quota_us';

  if (!fs.existsSync(period_path)) {
    return def_cpu;
  }

  if (!fs.existsSync(quota_path)) {
    return def_cpu;
  }

  var quota = parseInt(fs.readFileSync(quota_path, 'utf8').trim(), 10);
  if (quota === -1) {
    return def_cpu;
  }

  var period = parseInt(fs.readFileSync(period_path, 'utf8').trim(), 10);
  if (period <= 0) {
    return def_cpu;
  }

  return quota / period;
}

const _isPID = function (s) {
  if (typeof s !== 'string') {
    return false;
  }
  if (s.length === 0) {
    return false;
  }

  for (let i = 0; i < s.length; i++) {
    if ('0123456789'.indexOf(s[i]) < 0) {
      return false;
    }
  }
  return true;
};

var _getProcessCPU = function(p) {
  // process exists when get processes, process exit when read stat
  if (!fs.existsSync(p)) {
    return 0;
  }

  try {
    var pstat = fs.readFileSync(p, 'utf8').trim().split(' ');
    var used = parseInt(pstat[13], 10) +
               parseInt(pstat[14], 10) +
               parseInt(pstat[15], 10) +
               parseInt(pstat[16], 10);
    return used;
  } catch (err) {
    return 0;
  }
};

var getAllCPU = function() {
  const dir = '/proc'
  var processes = [];
  var all = fs.readdirSync(dir);
  var total = 0;
  for (let i = 0; i < all.length; i++) {
    let pid = all[i];
    if (_isPID(pid)) {
      processes.push(path.join(dir, pid, 'stat'))
    }
  }
  for (let i = 0; i < processes.length; i++) {
    total += _getProcessCPU(processes[i]);
  }
  return total;
}

var last_used = isInDocker() ? getAllCPU() : 0;
var last_sys = isInDocker ? new Date().getTime(): 0;

var calculateDockerCPU = function() {
  var now_used = getAllCPU();
  var now_sys = new Date().getTime();
  //
  var diff_used = (now_used - last_used) * 10;
  var diff_sys = now_sys - last_sys;
  last_used = now_used;
  last_sys = now_sys;
  // docker cpu useage percent %
  return diff_used / diff_sys / _getDockerCPUs();
};


var calculateCPU = function () {
  var cpus = os.cpus();
  var total = 0;
  var idle = 0;
  for (var i = 0; i < cpus.length; i++) {
    var time = cpus[i].times;
    total += time.user + time.nice + time.sys + time.idle;
    idle += time.idle;
  }

  var diffTotal = total - lastTotal;
  var diffIdle = idle - lastIdle;
  lastTotal = total;
  lastIdle = idle;

  return 1 - diffIdle / diffTotal;
};

var getSystemCPU = function () {
  if (isInDocker()) {
    var now_used = getAllCPU();
    var now_sys = new Date().getTime();
    //
    var diff_used = (now_used - last_used) * 10;
    var diff_sys = now_sys - last_sys;
    last_used = now_used;
    last_sys = now_sys;
    // docker cpu useage percent %
    return diff_used / diff_sys / _getDockerCPUs();
  } else if (os.type() === 'Linux') {
    return calculateLinuxCPU();
  } else {
    return calculateCPU();
  }
};


var getLoadAvg = function () {
  const load = fs.readFileSync('/proc/loadavg', 'utf8').trim();
  const reg  = /(\d.\d+)\s+(\d.\d+)\s+(\d.\d+)/
  const loads = load.match(reg);
  if (loads) {
    return [Number(loads[1]), Number(loads[2]), Number(loads[3])];
  } else {
    return os.loadavg();
  }
};

var getTotalMemory = function () {
  var raw = fs.readFileSync('/proc/meminfo');
  var usage = raw.toString().trim().split('\n');
  for (let i = 0; i < usage.length; i++) {
    var line = usage[i].split(':');
    if (line[0] === 'MemTotal') {
      return parseInt(line[1], 10) * 1024;
    }
  }
  // can not find MemTotal in meminfo, impossible
  return os.totalmem()
};

var getMemoryUsage = function () {
  var raw = fs.readFileSync('/proc/meminfo');
  var usage = raw.toString().trim().split('\n');
  var real_free = 0;

  usage.forEach(function(line) {
    var pair = line.split(':');
    if (['MemFree', 'Buffers', 'Cached'].indexOf(pair[0]) >= 0) {
      real_free += parseInt(pair[1], 10);
    }
  });
  return real_free * 1024;
};

var status = function () {
  const is_linux = os.type() === 'Linux';
  const loadavg = is_linux ? getLoadAvg() : os.loadavg();
  return {
    uptime: os.uptime(), // in ms
    totalmem: is_linux ? getTotalMemory() : os.totalmem(), // in byte
    freemem: is_linux ? getMemoryUsage() : os.freemem(), // in byte
    load1: loadavg[0],
    load5: loadavg[1],
    load15: loadavg[2],
    cpu: getSystemCPU(),
    cpu_count: os.cpus().length
  };
};

exports.run = function (callback) {
  callback(null, {
    type: 'system',
    metrics: status()
  });
};

