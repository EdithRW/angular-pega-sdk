import { Injectable } from '@angular/core';
import { endpoints, loginBoxType } from './endpoints';
import PegaAuth from '../_helpers/auth';
import { OAuthResponseService } from '../_messages/oauth-response.service';
import { ServerConfigService } from './server-config.service';

declare const PCore;

@Injectable({
  providedIn: 'root',
})
export class AuthService {
  authMgr: any;

  bNoInitialRedirect: boolean = sessionStorage.getItem('asdk_noRedirect') === '1';
  bLoggedIn: boolean = false;
  bUsePopupForRestOfSession: boolean = false;
  gbC11NBootstrapInProgress: boolean = false;
  // Some non Pega OAuth 2.0 Authentication in use (Basic or Custom for service package)
  gbCustomAuth: boolean = false;

  constructor(private scService: ServerConfigService, private oarservice: OAuthResponseService) {
    this.scService.readSdkConfig();
  }

  /*
   * Set to use popup experience for rest of session
   */
  forcePopupForReauths = (bForce) => {
    if (bForce) {
      sessionStorage.setItem('asdk_popup', '1');
      this.bUsePopupForRestOfSession = true;
    } else {
      sessionStorage.removeItem('asdk_popup');
      this.bUsePopupForRestOfSession = false;
    }
  };

  setNoInitialRedirect = (bNoInitialRedirect) => {
    if (bNoInitialRedirect) {
      this.forcePopupForReauths(true);
      sessionStorage.setItem('asdk_noRedirect', '1');
      this.bNoInitialRedirect = true;
    } else {
      sessionStorage.removeItem('asdk_noRedirect');
      this.bNoInitialRedirect = false;
    }
  };

  isLoginExpired = () => {
    let bExpired = true;
    const sLoginStart = sessionStorage.getItem('asdk_loggingIn');
    if (sLoginStart !== null) {
      const currTime = Date.now();
      bExpired = currTime - parseInt(sLoginStart, 10) > 60000;
    }
    return bExpired;
  };

  getCurrentTokens = () => {
    let tokens = null;
    const sTI = sessionStorage.getItem('asdk_TI');
    if (sTI !== null) {
      try {
        tokens = JSON.parse(sTI);
      } catch (e) {
        tokens = null;
      }
    }
    return tokens;
  };

  isLoginInProgress = () => {
    const bLoggingIn: boolean = sessionStorage.getItem('asdk_loggingIn') !== null;
    return bLoggingIn;
  };

  updateLoginStatus = () => {
    const sAuthHdr = this.sdkGetAuthHeader();
    this.bLoggedIn = sAuthHdr && sAuthHdr.length > 0;
  };

  /**
   * Initiate the process to get the Constellation bootstrap shell loaded and initialized
   * @param {Object} authConfig
   * @param {Object} tokenInfo
   */
  constellationInit = (authConfig: any, tokenInfo: any, authTokenUpdated, fnReauth) => {
    const constellationBootConfig: any = {};
    const sdkConfigServer = this.scService.getSdkConfigServer();

    // Set up constellationConfig with data that bootstrapWithAuthHeader expects
    constellationBootConfig.customRendering = true;
    constellationBootConfig.restServerUrl = sdkConfigServer.infinityRestServerUrl;
    // NOTE: Needs a trailing slash! So add one if not provided
    if (!sdkConfigServer.sdkContentServerUrl.endsWith('/')) {
      sdkConfigServer.sdkContentServerUrl = `${sdkConfigServer.sdkContentServerUrl}/`;
    }
    constellationBootConfig.staticContentServerUrl = `${sdkConfigServer.sdkContentServerUrl}constellation/`;
    if (!constellationBootConfig.staticContentServerUrl.endsWith('/')) {
      constellationBootConfig.staticContentServerUrl = `${constellationBootConfig.staticContentServerUrl}/`;
    }
    // If appAlias specified, use it
    if (sdkConfigServer.appAlias) {
      constellationBootConfig.appAlias = sdkConfigServer.appAlias;
    }

    if (tokenInfo) {
      // Pass in auth info to Constellation
      constellationBootConfig.authInfo = {
        authType: 'OAuth2.0',
        tokenInfo,
        // Set whether we want constellation to try to do a full re-Auth or not ()
        // true doesn't seem to be working in SDK scenario so always passing false for now
        popupReauth: false /* !authNoRedirect() */,
        client_id: authConfig.clientId,
        authentication_service: authConfig.authService,
        redirect_uri: authConfig.redirectUri,
        endPoints: {
          authorize: authConfig.authorizeUri,
          token: authConfig.tokenUri,
          revoke: authConfig.revokeUri,
        },
        // TODO: setup callback so we can update own storage
        onTokenRetrieval: this.updateTokens.bind(this),
      };
    } else {
      constellationBootConfig.authorizationHeader = this.sdkGetAuthHeader();
    }

    // Turn off dynamic load components (should be able to do it here instead of after load?)
    constellationBootConfig.dynamicLoadComponents = false;

    if (this.gbC11NBootstrapInProgress) {
      return;
    } else {
      this.gbC11NBootstrapInProgress = true;
    }

    // Note that staticContentServerUrl already ends with a slash (see above), so no slash added.
    // In order to have this import succeed and to have it done with the webpackIgnore magic comment tag.  See:  https://webpack.js.org/api/module-methods/
    import(/* webpackIgnore: true */ `${constellationBootConfig.staticContentServerUrl}bootstrap-shell.js`)
      .then((bootstrapShell) => {
        // NOTE: once this callback is done, we lose the ability to access loadMashup.
        //  So, create a reference to it
        window.myLoadMashup = bootstrapShell.loadMashup;
        window.myLoadPortal = bootstrapShell.loadPortal;
        window.myLoadDefaultPortal = bootstrapShell.loadDefaultPortal;

        bootstrapShell
          .bootstrapWithAuthHeader(constellationBootConfig, 'app-root')
          .then(() => {
            console.log('Bootstrap successful!');
            this.gbC11NBootstrapInProgress = false;

            // Setup listener for the reauth event
            if (tokenInfo) {
              PCore.getPubSubUtils().subscribe(PCore.getConstants().PUB_SUB_EVENTS.EVENT_FULL_REAUTH, this.fullReauth.bind(this), 'authFullReauth');
            } else {
              // customReauth event introduced with 8.8

              const sEvent = PCore.getConstants().PUB_SUB_EVENTS.EVENT_CUSTOM_REAUTH;
              if (sEvent) {
                PCore.getPubSubUtils().subscribe(sEvent, this.authCustomReauth.bind(this), 'doReauth');
              }
            }

            // Fire SdkConstellationReady event so bridge and app route can do expected post PCore initializations
            const event = new CustomEvent('SdkConstellationReady', {});
            document.dispatchEvent(event);
          })
          .catch((e) => {
            // Assume error caught is because token is not valid and attempt a full reauth
            console.error(`Constellation JS Engine bootstrap failed. ${e}`);
            this.gbC11NBootstrapInProgress = false;
            this.fullReauth();
          });
      })
      .catch((e) => {
        console.error(`Failed to import bootstrap-shell.js. ${e}`);
      });
    /* Ends here */
  };

  fireTokenAvailable = (token, bLoadC11N = true) => {
    if (!token) {
      // This is used on page reload to load the token from sessionStorage and carry on
      token = this.getCurrentTokens();
      if (!token) {
        return;
      }
    }

    sessionStorage.setItem('asdk_AH', `${token.token_type} ${token.access_token}`);
    this.updateLoginStatus();

    // bLoggedIn is getting updated in updateLoginStatus
    this.bLoggedIn = true;
    sessionStorage.removeItem('asdk_loggingIn');
    this.forcePopupForReauths(true);

    const sSI = sessionStorage.getItem('asdk_CI');
    let authConfig = null;
    if (sSI !== null) {
      try {
        authConfig = JSON.parse(sSI);
      } catch (e) {
        // do nothing
      }
    }

    // Fire event which indicates the token has changed
    this.oarservice.sendMessage(token);

    // Was firing an event to boot constellation, but thinking might be better to just do that here.
    /*
    // Create and dispatch the SdkLoggedIn event to trigger constellationInit
    const event = new CustomEvent('SdkLoggedIn', { detail: { authConfig, tokenInfo: token } });
    document.dispatchEvent(event);
    */
    // Code that sets up use of Constellation once it's been loaded and ready
    if (!window.PCore && bLoadC11N) {
      this.constellationInit(authConfig, token, this.authTokenUpdated, this.authFullReauth.bind(this));
    }
  };

  updateTokens = (token) => {
    sessionStorage.setItem('asdk_TI', JSON.stringify(token));
    const authToken = token.token_type + ' ' + token.access_token;
    sessionStorage.setItem('asdk_AH', authToken);
    sessionStorage.removeItem('asdk_loggingIn');
    //console.log("updateTokens(tkn): clearing loggingIn");
    this.updateLoginStatus();
  };

  processTokenOnLogin = (token, bLoadC11N = true) => {
    this.updateTokens(token);
    if (window.PCore) {
      window.PCore.getAuthUtils().setTokens(token);
    } else {
      this.fireTokenAvailable(token, bLoadC11N);
    }
  };

  updateRedirectUri = (aMgr, sRedirectUri) => {
    const sSI = sessionStorage.getItem('asdk_CI');
    let authConfig = null;
    if (sSI !== null) {
      try {
        authConfig = JSON.parse(sSI);
      } catch (e) {
        // do nothing
      }
    }
    authConfig.redirectUri = sRedirectUri;
    sessionStorage.setItem('asdk_CI', JSON.stringify(authConfig));
    aMgr.reloadConfig();
  };

  authRedirectCallback = (href, fnLoggedInCB = null) => {
    // Get code from href and swap for token
    const aHrefParts = href.split('?');
    const urlParams = new URLSearchParams(aHrefParts.length > 1 ? `?${aHrefParts[1]}` : '');
    const code = urlParams.get('code');

    this.getAuthMgr(false).then((aMgr) => {
      aMgr.getToken(code).then((token) => {
        if (token && token.access_token) {
          this.processTokenOnLogin(token, false);
          // this.getUserInfo();
          if (fnLoggedInCB) {
            fnLoggedInCB(token.access_token);
          }
        }
      });
    });
  };

  /**
   * Clean up any web storage allocated for the user session.
   */
  clearAuthMgr = (bFullReauth: boolean = false) => {
    // Remove any local storage for the user
    // Remove any local storage for the user
    if (!this.gbCustomAuth) {
      sessionStorage.removeItem('asdk_AH');
    }
    if (!bFullReauth) {
      sessionStorage.removeItem('asdk_CI');
    }
    sessionStorage.removeItem('asdk_TI');
    sessionStorage.removeItem('asdk_UI');
    sessionStorage.removeItem('asdk_loggingIn');
    //console.log("clearAuthMgr(): clearing loggingIn")
    this.bLoggedIn = false;
    this.forcePopupForReauths(bFullReauth);
    // Not removing the authMgr structure itself...as it can be leveraged on next login
  };

  authNoRedirect = () => {
    return sessionStorage.getItem('asdk_noRedirect') === '1';
  };

  initOAuth = async (bInit) => {
    const sdkConfigAuth = await this.scService.getSdkConfigAuth();
    const sdkConfigServer = this.scService.getSdkConfigServer();
    let pegaUrl = sdkConfigServer.infinityRestServerUrl;
    const bNoInitialRedirect = this.authNoRedirect();

    // Construct default OAuth endpoints (if not explicitly specified)
    if (pegaUrl) {
      // Cope with trailing slash being present
      if (!pegaUrl.endsWith('/')) {
        pegaUrl += '/';
      }
      if (!sdkConfigAuth.authorize) {
        sdkConfigAuth.authorize = `${pegaUrl}PRRestService/oauth2/v1/authorize`;
      }
      if (!sdkConfigAuth.token) {
        sdkConfigAuth.token = `${pegaUrl}PRRestService/oauth2/v1/token`;
      }
      if (!sdkConfigAuth.revoke) {
        sdkConfigAuth.revoke = `${pegaUrl}PRRestService/oauth2/v1/revoke`;
      }
      if (!sdkConfigAuth.redirectUri) {
        sdkConfigAuth.redirectUri = `${window.location.origin}${window.location.pathname}`;
      }
      if (!sdkConfigAuth.userinfo) {
        const appAliasSeg = sdkConfigServer.appAlias ? `app/${sdkConfigServer.appAlias}/` : '';
        sdkConfigAuth.userinfo = `${pegaUrl}${appAliasSeg}api/oauthclients/v1/userinfo/JSON`;
      }
    }
    // Auth service alias
    if (!sdkConfigAuth.authService) {
      sdkConfigAuth.authService = 'pega';
    }

    // Construct path to auth.html (used for case when not doing a main window redirect)
    let sNoMainRedirectUri = sdkConfigAuth.redirectUri;
    const nLastPathSep = sNoMainRedirectUri.lastIndexOf('/');
    sNoMainRedirectUri = nLastPathSep !== -1 ? `${sNoMainRedirectUri.substring(0, nLastPathSep + 1)}auth.html` : `${sNoMainRedirectUri}/auth.html`;

    const authConfig: any = {
      clientId: bNoInitialRedirect ? sdkConfigAuth.mashupClientId : sdkConfigAuth.portalClientId,
      authorizeUri: sdkConfigAuth.authorize,
      tokenUri: sdkConfigAuth.token,
      revokeUri: sdkConfigAuth.revoke,
      userinfoUri: sdkConfigAuth.userinfo,
      redirectUri:
        bNoInitialRedirect || this.bUsePopupForRestOfSession || endpoints.loginExperience === loginBoxType.Popup
          ? sNoMainRedirectUri
          : sdkConfigAuth.redirectUri,
      authService: sdkConfigAuth.authService,
      appAlias: sdkConfigServer.appAlias || '',
      useLocking: true,
    };
    // If no clientId is specified assume not OAuth but custom auth
    if (!authConfig.clientId) {
      this.gbCustomAuth = true;
      return;
    }
    if ('silentTimeout' in sdkConfigAuth) {
      authConfig.silentTimeout = sdkConfigAuth.silentTimeout;
    }
    if (bNoInitialRedirect && sdkConfigAuth.mashupUserIdentifier && sdkConfigAuth.mashupPassword) {
      authConfig.userIdentifier = sdkConfigAuth.mashupUserIdentifier;
      authConfig.password = sdkConfigAuth.mashupPassword;
    }
    if ('iframeLoginUI' in sdkConfigAuth) {
      authConfig.iframeLoginUI = sdkConfigAuth.iframeLoginUI.toString().toLowerCase() === 'true';
    }

    // Check if sessionStorage exists (and if so if for same authorize endpoint).  Otherwise, assume
    //  sessionStorage is out of date (user just edited endpoints).  Else, logout required to clear
    //  sessionStorage and get other endpoints updates.
    // Doing this as sessionIndex might have been added to this storage structure
    let sSI = sessionStorage.getItem('asdk_CI');
    if (sSI !== null) {
      try {
        const oSI = JSON.parse(sSI);
        if (
          oSI.authorizeUri !== authConfig.authorizeUri ||
          oSI.appAlias !== authConfig.appAlias ||
          oSI.clientId !== authConfig.clientId ||
          oSI.userIdentifier !== authConfig.userIdentifier ||
          oSI.password !== authConfig.password
        ) {
          this.clearAuthMgr();
          sSI = null;
        }
      } catch (e) {
        // do nothing
      }
    }

    if (!sSI || bInit) {
      sessionStorage.setItem('asdk_CI', JSON.stringify(authConfig));
    }
    this.authMgr = new PegaAuth('asdk_CI');
  };

  getAuthMgr = (bInit): Promise<any> => {
    return new Promise((resolve) => {
      let idNextCheck = null;
      const fnCheckForAuthMgr = () => {
        if (PegaAuth && !this.authMgr) {
          this.initOAuth(bInit);
        }
        if (this.authMgr) {
          if (idNextCheck) {
            clearInterval(idNextCheck);
          }
          return resolve(this.authMgr);
        }
      };
      fnCheckForAuthMgr();
      idNextCheck = setInterval(fnCheckForAuthMgr, 10);
    });
  };

  sdkGetAuthHeader = () => {
    return sessionStorage.getItem('asdk_AH');
  };

  // Set the custom authorization header for the SDK (and Constellation JS Engine) to
  // utilize for every DX API request
  setAuthHeader = (authHeader) => {
    // set this within session storage so it survives a browser reload
    if (authHeader) {
      sessionStorage.setItem('asdk_AH', authHeader);
      // setAuthorizationHeader method not available til 8.8 so do safety check
      if (window.PCore?.getAuthUtils().setAuthorizationHeader) {
        window.PCore.getAuthUtils().setAuthorizationHeader(authHeader);
      }
    } else {
      sessionStorage.removeItem('asdk_AH');
    }
    this.gbCustomAuth = true;
  };

  // Initialize a custom re-authorization
  authCustomReauth = () => {
    // Fire the SdkCustomReauth event to indicate a new authHeader is needed. Event listener should invoke sdkSetAuthHeader
    //  to communicate the new token to sdk (and Constellation JS Engine)
    const event = new CustomEvent('SdkCustomReauth', { detail: this.setAuthHeader.bind(this) });
    document.dispatchEvent(event);
  };

  // TODO: Cope with 401 and refresh token if possible (or just hope that it succeeds during login)
  /**
   * Retrieve UserInfo for current authentication service
   */
  getUserInfo = (bUseSS = true) => {
    const ssUserInfo = sessionStorage.getItem('asdk_UI');
    let userInfo = null;
    if (bUseSS && ssUserInfo) {
      try {
        userInfo = JSON.parse(ssUserInfo);
        return Promise.resolve(userInfo);
      } catch (e) {
        // do nothing
      }
    }
    this.getAuthMgr(false).then((aMgr) => {
      const tokenInfo = this.getCurrentTokens();
      return aMgr.getUserinfo(tokenInfo.access_token).then((data) => {
        userInfo = data;
        if (userInfo) {
          sessionStorage.setItem('asdk_UI', JSON.stringify(userInfo));
        } else {
          sessionStorage.removeItem('asdk_UI');
        }
        return Promise.resolve(userInfo);
      });
    });
  };

  login = (bFullReauth: boolean = false) => {
    if (this.gbCustomAuth) return;

    this.getAuthMgr(bFullReauth).then(async (aMgr) => {
      const bMainRedirect = !this.authNoRedirect();
      const sdkConfigAuth = await this.scService.getSdkConfigAuth();
      let sRedirectUri = sdkConfigAuth.redirectUri;

      // If initial main redirect is OK, redirect to main page, otherwise will authorize in a popup window
      if (bMainRedirect && !bFullReauth) {
        // update redirect uri to be the root
        this.updateRedirectUri(aMgr, sRedirectUri);
        aMgr.loginRedirect();
        // Don't have token til after the redirect
        return Promise.resolve(undefined);
      } else {
        // Construct path to redirect uri
        const nLastPathSep = sRedirectUri.lastIndexOf('/');
        sRedirectUri = nLastPathSep !== -1 ? `${sRedirectUri.substring(0, nLastPathSep + 1)}auth.html` : `${sRedirectUri}/auth.html`;
        // Set redirectUri to static auth.html
        this.updateRedirectUri(aMgr, sRedirectUri);
        return new Promise((resolve, reject) => {
          aMgr
            .login()
            .then((token) => {
              this.processTokenOnLogin(token);
              // getUserInfo();
              resolve(token.access_token);
            })
            .catch((e) => {
              sessionStorage.removeItem('asdk_loggingIn');
              console.log(e);
              reject(e);
            });
        });
      }
    });
  };

  /**
   * Silent or visible login based on login status
   *  @param {string} appName - unique name for application route (will be used to clear an session storage for another route)
   *  @param {boolean} noMainRedirect - avoid the initial main window redirect that happens in scenarios where it is OK to transition
   *   away from the main page
   *  @param {boolean} deferLogin - defer logging in (if not already authenticated)
   */
  loginIfNecessary = (appName, noMainRedirect: boolean = false, deferLogin = false) => {
    // If no initial redirect status of page changed...clearAuthMgr
    const currNoMainRedirect = this.authNoRedirect();
    const currAppName = sessionStorage.getItem('asdk_appName');
    if (appName !== currAppName || noMainRedirect !== currNoMainRedirect) {
      this.clearAuthMgr();
      sessionStorage.setItem('asdk_appName', appName);
    }
    this.setNoInitialRedirect(noMainRedirect);
    // If custom auth no need to do any OAuth logic
    if (this.gbCustomAuth) {
      if (!window.PCore) {
        this.constellationInit(null, null, null, this.authCustomReauth.bind(this));
      }
      return;
    }

    // If this is the login redirect with auth code
    // eslint-disable-next-line @typescript-eslint/prefer-includes
    if (window.location.href.indexOf('?code') !== -1) {
      // initialize authMgr
      this.initOAuth(false);
      return this.getAuthMgr(false).then(() => {
        this.authRedirectCallback(window.location.href, () => {
          window.location.href = window.location.pathname;
        });
      });
    }
    // If not login redirect with auth code
    if (!deferLogin && (!this.isLoginInProgress() || this.isLoginExpired())) {
      this.getAuthMgr(false).then(() => {
        this.updateLoginStatus();
        if (this.bLoggedIn) {
          this.fireTokenAvailable(this.getCurrentTokens());
          // this.getUserInfo();
        } else {
          return this.login();
        }
      });
    }
  };

  fullReauth = () => {
    const bHandleHere = true; // Other alternative is to raise an event and have someone else handle it

    if (bHandleHere) {
      // Don't want to do a full clear of authMgr as will loose sessionIndex.  Rather just clear the tokens
      this.clearAuthMgr(true);
      this.login(true);
    } else {
      // Create and dispatch the SdkLoggedIn event to trigger constellationInit
      // detail will be callback function to call once a new token structure is obtained
      const event = new CustomEvent('SdkFullReauth', { detail: this.processTokenOnLogin.bind(this) });
      document.dispatchEvent(event);
    }
  };

  // Passive update where just session storage is updated so can be used on a window refresh
  authTokenUpdated = (tokenInfo) => {
    sessionStorage.setItem('rsdk_TI', JSON.stringify(tokenInfo));
  };

  logout = () => {
    return new Promise<void>((resolve) => {
      const fnClearAndResolve = () => {
        this.clearAuthMgr();

        const event = new Event('SdkLoggedOut');
        document.dispatchEvent(event);

        resolve();
      };
      if (this.gbCustomAuth) {
        sessionStorage.removeItem('asdk_AH');
        fnClearAndResolve();
        return;
      }
      const tokenInfo = this.getCurrentTokens();
      if (tokenInfo && tokenInfo.access_token) {
        if (window.PCore) {
          window.PCore.getAuthUtils()
            .revokeTokens()
            .then(() => {
              fnClearAndResolve();
            })
            .catch((err) => {
              console.log('Error:', err?.message);
            });
        } else {
          this.authMgr
            .revokeTokens(tokenInfo.access_token, tokenInfo.refresh_token)
            .then(() => {
              // Go to finally
            })
            .finally(() => {
              fnClearAndResolve();
            });
        }
      } else {
        fnClearAndResolve();
      }
    });
  };

  // Callback routine for custom event to ask for updated tokens
  authUpdateTokens = (token) => {
    this.processTokenOnLogin(token);
  };

  // Initiate a full OAuth re-authorization (any refresh token has also expired).
  authFullReauth = () => {
    const bHandleHere = true; // Other alternative is to raise an event and have someone else handle it

    if (bHandleHere) {
      // Don't want to do a full clear of authMgr as will loose sessionIndex.  Rather just clear the tokens
      this.clearAuthMgr(true);
      this.login(true);
    } else {
      // Fire the SdkFullReauth event to indicate a new token is needed (PCore.getAuthUtils.setTokens method
      //  should be used to communicate the new token to Constellation JS Engine.
      const event = new CustomEvent('SdkFullReauth', { detail: this.authUpdateTokens });
      document.dispatchEvent(event);
    }
  };
}
