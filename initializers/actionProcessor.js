var domain = require('domain');
var async = require('async');

var actionProcessor = function(api, next){

  var duplicateCallbackErrorTimeout = 500;

  api.actionProcessor = function(data){
    if(data.connection == null){ throw new Error('data.connection is required') }
    this.connection = this.buildProxyConnection(data.connection);
    this.messageCount = this.connection.messageCount
    this.callback = data.callback;
    this.working = false;
  }

  api.actionProcessor.prototype.buildProxyConnection = function(connection){
    var proxyConnection = {};
    for(var i in connection){
      if(connection.hasOwnProperty(i)){
        proxyConnection[i] = connection[i];
      }
    }
    proxyConnection._original_connection = connection
    return proxyConnection;
  }

  api.actionProcessor.prototype.incrementTotalActions = function(count){
    if(count == null){ count = 1 }
    this.connection._original_connection.totalActions = this.connection._original_connection.totalActions + count;
  }

  api.actionProcessor.prototype.incrementPendingActions = function(count){
    if(count == null){ count = 1 }
    this.connection._original_connection.pendingActions = this.connection._original_connection.pendingActions + count;
  }

  api.actionProcessor.prototype.getPendingActionCount = function(){
    return this.connection._original_connection.pendingActions;
  }

  api.actionProcessor.prototype.completeAction = function(error, toRender, actionDomain){
    var self = this;
    if(actionDomain != null){ actionDomain.exit(); }
    if(error != null){ self.connection.error = error }
    if(self.connection.error instanceof Error){
      self.connection.error = String(self.connection.error);
    }
    if(self.connection.error != null && self.connection.response.error == null){
      self.connection.response.error = self.connection.error;
    }
    if(toRender == null){ toRender = true }
    self.incrementPendingActions(-1);
    api.stats.increment('actions:actionsCurrentlyProcessing', -1);
    self.duration = new Date().getTime() - self.actionStartTime;

    process.nextTick(function(){

      self.connection._original_connection.action = self.connection.action;
      self.connection._original_connection.error = self.connection.error;
      self.connection._original_connection.response = self.connection.response || {};

      if(typeof self.callback == 'function'){
        self.callback(self.connection._original_connection, toRender, self.messageCount);
      }

      var logLevel = 'info';
      if(self.actionTemplate != null && self.actionTemplate.logLevel != null){
        logLevel = self.actionTemplate.logLevel;
      }
      var stringifiedError = '';
      try {
        stringifiedError = JSON.stringify(self.connection.error);
      } catch(e){
        stringifiedError = String(self.connection.error)
      }
      
      var filteredParams = {}
      for(var i in self.connection.params){
        if(api.config.general.filteredParams != null && api.config.general.filteredParams.indexOf(i) >= 0){
          filteredParams[i] = "[FILTERED]";
        }else{
          filteredParams[i] = self.connection.params[i];
        }
      }

      api.log('[ action @ ' + self.connection.type + ' ]', logLevel, {
        to: self.connection.remoteIP,
        action: self.connection.action,
        params: JSON.stringify(filteredParams),
        duration: self.duration,
        error: stringifiedError
      });

      self.working = false;

    });
  }

  api.actionProcessor.prototype.preProcessAction = function(toProcess, callback){
    var self = this;
    if(api.actions.preProcessors.length == 0){
      callback(toProcess);
    } else {
      var processors = [];
      api.actions.preProcessors.forEach(function(processor){
        processors.push(function(next){
          if(toProcess === true){
            processor(self.connection, self.actionTemplate, function(connection, localToProcess){
              self.connection = connection;
              if(localToProcess != null){ toProcess = localToProcess; }
              next();
            });
          } else { next(toProcess) }
        })
      });
      processors.push(function(){ callback(toProcess) });
      async.series(processors);
    }
  }

  api.actionProcessor.prototype.postProcessAction = function(toRender, callback){
    var self = this;
    if(api.actions.postProcessors.length == 0){
      callback(toRender);
    } else {
      var processors = [];
      api.actions.postProcessors.forEach(function(processor){
        processors.push(function(next){
          processor(self.connection, self.actionTemplate, toRender, function(connection, localToRender){
            self.connection = connection;
            if(localToRender != null){ toRender = localToRender; }
            next();
          });
        })
      });
      processors.push(function(){ callback(toRender) });
      async.series(processors);
    }
  }

  api.actionProcessor.prototype.reduceParams = function(){
    var self = this;
    if(api.config.general.disableParamScrubbing !== true){
      for(var p in self.connection.params){
        if(
            api.params.postVariables.indexOf(p) < 0 &&
            self.actionTemplate.inputs.required.indexOf(p) < 0 &&
            self.actionTemplate.inputs.optional.indexOf(p) < 0
        ){
          delete self.connection.params[p];
        }
      }
    }
  }

  api.actionProcessor.prototype.duplicateCallbackHandler = function(error, actionDomain){
    var self = this;
    if(self.working == true){
      setTimeout(function(){
        self.duplicateCallbackHandler(error, actionDomain);
      }, duplicateCallbackErrorTimeout)
    }else{
      process.nextTick(function(){
        api.exceptionHandlers.action(actionDomain, new Error(error), self.connection);
      });
    }
  }

  api.actionProcessor.prototype.processAction = function(){
    var self = this;
    self.actionStartTime = new Date().getTime();
    self.working = true;
    self.incrementTotalActions();
    self.incrementPendingActions();

    self.connection.action = self.connection.params['action'];
    if(api.actions.versions[self.connection.action] != null){
      if(self.connection.params.apiVersion == null){
        self.connection.params.apiVersion = api.actions.versions[self.connection.action][api.actions.versions[self.connection.action].length - 1];
      }
      self.actionTemplate = api.actions.actions[self.connection.action][self.connection.params.apiVersion];
    }
    api.stats.increment('actions:actionsCurrentlyProcessing');

    if(api.running != true){
      self.completeAction('the server is shutting down');
    } else if(self.getPendingActionCount(self.connection) > api.config.general.simultaneousActions){
      self.completeAction('you have too many pending requests');
    } else if(self.connection.error !== null){
      self.completeAction();
    } else if(self.connection.action == null || self.actionTemplate == null){
      api.stats.increment('actions:actionsNotFound');
      if(self.connection.action == '' || self.connection.action == null){ self.connection.action = '{no action}'; }
      self.connection.error = new Error(self.connection.action + ' is not a known action or that is not a valid apiVersion.');
      self.completeAction();
    } else if(self.actionTemplate.blockedConnectionTypes != null && self.actionTemplate.blockedConnectionTypes.indexOf(self.connection.type) >= 0){
      self.connection.error = new Error('this action does not support the ' + self.connection.type + ' connection type');
      self.completeAction();
    } else {
      if(self.connection.error === null){
        api.stats.increment('actions:totalProcessedActions');
        api.stats.increment('actions:processedActions:' + self.connection.action);
        var actionDomain = domain.create();
        actionDomain.on('error', function(err){
          api.exceptionHandlers.action(actionDomain, err, self.connection, function(){
            self.completeAction(null, true, actionDomain);
          });
        });
        actionDomain.run(function(){
          process.nextTick(function(){
            var toProcess = true;
            var callbackCount = 0;
            self.preProcessAction(toProcess, function(toProcess){
              self.reduceParams();
              api.params.requiredParamChecker(self.connection, self.actionTemplate.inputs.required);
              if(toProcess === true && self.connection.error === null){
                self.actionTemplate.run(api, self.connection, function(connection, toRender){
                  callbackCount++;
                  if(callbackCount !== 1){ 
                    callbackCount = 1; 
                    self.duplicateCallbackHandler('Double callback prevented within action', actionDomain); 
                  }else{
                    self.connection = connection;
                    self.postProcessAction(toRender, function(toRender){
                      self.completeAction(null, toRender, actionDomain);
                    });
                  }
                });
              } else {
                self.completeAction(null, true, actionDomain);
              }
            });
          });
        });
      } else {
        self.completeAction();
      }
    }
  }

  next();
}

/////////////////////////////////////////////////////////////////////
// exports
exports.actionProcessor = actionProcessor;
