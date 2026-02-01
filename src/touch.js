// Touch controls for mobile devices
// Provides virtual joystick on left, look area on right with tap-to-jump

import { K_ESCAPE, K_ENTER, K_UPARROW, K_DOWNARROW, Key_Event, key_game, key_menu, key_dest } from './keys.js';
import { in_jump, in_attack } from './cl_input.js';
import { S_UnlockAudio } from './snd_dma.js';

// Touch state
let enabled = false;
let initialized = false;
let menuOverlay = null;
let menuTouchCallback = null;
let fullscreenActivated = false;

// Movement joystick (left side)
let moveTouch = null;
let joystickOrigin = { x: 0, y: 0 };
let joystickCurrent = { x: 0, y: 0 };

// Look area (right side)
let lookTouch = null;
let lastLookPos = { x: 0, y: 0 };
let lookTouchOrigin = { x: 0, y: 0 };
let lookTouchDist = 0;

// Accumulated values for IN_Move
let moveForward = 0;
let moveRight = 0;
let lookDeltaX = 0;
let lookDeltaY = 0;
let jumpImpulse = false;

// UI elements
let overlay = null;
let joystickArea = null;
let joystickBase = null;
let joystickKnob = null;
let lookArea = null;
let fireButton = null;
let pauseButton = null;

/*
=================
Touch_IsMobile

Detect if we're on a mobile device
=================
*/
export function Touch_IsMobile() {

	return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test( navigator.userAgent ) ||
		( navigator.maxTouchPoints && navigator.maxTouchPoints > 2 );

}

/*
=================
Touch_CreateUI

Create the touch control UI elements
=================
*/
function Touch_CreateUI( container ) {

	// Main overlay
	overlay = document.createElement( 'div' );
	overlay.id = 'touch-controls';
	overlay.style.cssText = `
		position: fixed;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
		z-index: 200;
		display: none;
		touch-action: none;
	`;

	// Left side - movement joystick area
	joystickArea = document.createElement( 'div' );
	joystickArea.style.cssText = `
		position: absolute;
		left: 0;
		top: 0;
		width: 40%;
		height: 100%;
		pointer-events: auto;
		touch-action: none;
	`;

	// Joystick base (appears when touching)
	joystickBase = document.createElement( 'div' );
	joystickBase.style.cssText = `
		position: fixed;
		width: 120px;
		height: 120px;
		border-radius: 50%;
		background: rgba(255, 255, 255, 0.15);
		border: 2px solid rgba(255, 255, 255, 0.3);
		display: none;
		transform: translate(-50%, -50%);
		pointer-events: none;
	`;

	// Joystick knob
	joystickKnob = document.createElement( 'div' );
	joystickKnob.style.cssText = `
		position: absolute;
		width: 50px;
		height: 50px;
		border-radius: 50%;
		background: rgba(255, 255, 255, 0.4);
		border: 2px solid rgba(255, 255, 255, 0.6);
		left: 50%;
		top: 50%;
		transform: translate(-50%, -50%);
	`;
	joystickBase.appendChild( joystickKnob );
	joystickArea.appendChild( joystickBase );

	// Right side - look area (tap to jump, drag to look)
	lookArea = document.createElement( 'div' );
	lookArea.style.cssText = `
		position: absolute;
		right: 0;
		top: 0;
		width: 60%;
		height: 100%;
		pointer-events: auto;
		touch-action: none;
	`;

	// Fire button (bottom right)
	fireButton = document.createElement( 'div' );
	fireButton.style.cssText = `
		position: absolute;
		right: 20px;
		bottom: 20px;
		width: 70px;
		height: 70px;
		border-radius: 50%;
		background: rgba(255, 100, 100, 0.3);
		border: 2px solid rgba(255, 100, 100, 0.5);
		pointer-events: auto;
		touch-action: none;
		display: flex;
		align-items: center;
		justify-content: center;
		font-family: sans-serif;
		font-size: 12px;
		color: rgba(255, 255, 255, 0.7);
	`;
	fireButton.textContent = 'FIRE';

	// Pause button (top right corner)
	pauseButton = document.createElement( 'div' );
	pauseButton.style.cssText = `
		position: absolute;
		right: 20px;
		top: 20px;
		width: 40px;
		height: 40px;
		border-radius: 5px;
		background: rgba(255, 255, 255, 0.15);
		border: 1px solid rgba(255, 255, 255, 0.3);
		pointer-events: auto;
		touch-action: none;
		display: flex;
		align-items: center;
		justify-content: center;
		font-family: sans-serif;
		font-size: 16px;
		color: rgba(255, 255, 255, 0.7);
	`;
	pauseButton.textContent = '| |';

	// Assemble UI
	overlay.appendChild( joystickArea );
	overlay.appendChild( lookArea );
	overlay.appendChild( fireButton );
	overlay.appendChild( pauseButton );

	container.appendChild( overlay );

	// Create menu navigation overlay
	Touch_CreateMenuUI( container );

}

/*
=================
Touch_CreateMenuUI

Create fullscreen touch area for menu tap-to-select
=================
*/
function Touch_CreateMenuUI( container ) {

	menuOverlay = document.createElement( 'div' );
	menuOverlay.id = 'touch-menu-controls';
	menuOverlay.style.cssText = `
		position: fixed;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		display: none;
		z-index: 199;
		pointer-events: auto;
		touch-action: none;
	`;

	menuOverlay.addEventListener( 'touchstart', ( e ) => {

		e.preventDefault();

		// Unlock audio on first user gesture
		S_UnlockAudio();

		if ( e.touches.length > 0 ) {

			const touch = e.touches[ 0 ];
			const x = touch.clientX;
			const y = touch.clientY;

			// Call the menu touch handler if set
			if ( menuTouchCallback ) {

				menuTouchCallback( x, y, window.innerWidth, window.innerHeight );

			}

		}

	}, { passive: false } );

	container.appendChild( menuOverlay );

}

/*
=================
Touch event handlers
=================
*/

function onTouchStart( e ) {

	e.preventDefault();

	// Unlock audio on first user gesture
	S_UnlockAudio();

	// Debug: log which element received the touch
	console.log( 'Touch start on:', e.currentTarget === joystickArea ? 'joystickArea' :
		e.currentTarget === lookArea ? 'lookArea' :
			e.currentTarget === fireButton ? 'fireButton' :
				e.currentTarget === pauseButton ? 'pauseButton' : 'unknown' );

	for ( const touch of e.changedTouches ) {

		const target = e.currentTarget;

		if ( target === joystickArea && moveTouch === null ) {

			// Start joystick
			moveTouch = touch.identifier;
			joystickOrigin.x = touch.clientX;
			joystickOrigin.y = touch.clientY;
			joystickCurrent.x = touch.clientX;
			joystickCurrent.y = touch.clientY;

			// Show joystick at touch position
			joystickBase.style.display = 'block';
			joystickBase.style.left = touch.clientX + 'px';
			joystickBase.style.top = touch.clientY + 'px';

		} else if ( target === lookArea && lookTouch === null ) {

			// Start look (also tracks tap for jump)
			lookTouch = touch.identifier;
			lastLookPos.x = touch.clientX;
			lastLookPos.y = touch.clientY;
			lookTouchOrigin.x = touch.clientX;
			lookTouchOrigin.y = touch.clientY;
			lookTouchDist = 0;

		} else if ( target === fireButton ) {

			in_attack.state |= 1 + 2; // down + impulse down
			fireButton.style.background = 'rgba(255, 100, 100, 0.5)';

		} else if ( target === pauseButton ) {

			// Trigger escape key
			Key_Event( K_ESCAPE, true );
			Key_Event( K_ESCAPE, false );

		}

	}

}

function onTouchMove( e ) {

	e.preventDefault();

	for ( const touch of e.changedTouches ) {

		if ( touch.identifier === moveTouch ) {

			// Update joystick
			joystickCurrent.x = touch.clientX;
			joystickCurrent.y = touch.clientY;

			// Calculate offset from origin
			const dx = joystickCurrent.x - joystickOrigin.x;
			const dy = joystickCurrent.y - joystickOrigin.y;

			// Clamp to max radius
			const maxRadius = 50;
			const dist = Math.sqrt( dx * dx + dy * dy );
			let clampedX = dx;
			let clampedY = dy;

			if ( dist > maxRadius ) {

				clampedX = ( dx / dist ) * maxRadius;
				clampedY = ( dy / dist ) * maxRadius;

			}

			// Update knob position
			joystickKnob.style.left = `calc(50% + ${clampedX}px)`;
			joystickKnob.style.top = `calc(50% + ${clampedY}px)`;

			// Convert to normalized input (-1 to 1)
			// Note: Y is inverted (up = forward = positive)
			moveRight = clampedX / maxRadius;
			moveForward = - clampedY / maxRadius;

		} else if ( touch.identifier === lookTouch ) {

			// Calculate look delta
			const dx = touch.clientX - lastLookPos.x;
			const dy = touch.clientY - lastLookPos.y;

			lookDeltaX += dx;
			lookDeltaY += dy;

			lastLookPos.x = touch.clientX;
			lastLookPos.y = touch.clientY;

			// Track total distance from origin (for tap detection)
			const totalDx = touch.clientX - lookTouchOrigin.x;
			const totalDy = touch.clientY - lookTouchOrigin.y;
			lookTouchDist = Math.sqrt( totalDx * totalDx + totalDy * totalDy );

		}

	}

}

function onTouchEnd( e ) {

	e.preventDefault();

	for ( const touch of e.changedTouches ) {

		const target = e.currentTarget;

		if ( touch.identifier === moveTouch ) {

			// Reset joystick
			moveTouch = null;
			moveForward = 0;
			moveRight = 0;
			joystickBase.style.display = 'none';
			joystickKnob.style.left = '50%';
			joystickKnob.style.top = '50%';

		} else if ( touch.identifier === lookTouch ) {

			// End look - if barely moved, it was a tap = jump
			if ( lookTouchDist < 15 ) {

				jumpImpulse = true;

			}

			lookTouch = null;

		} else if ( target === fireButton ) {

			in_attack.state &= ~1; // up
			in_attack.state |= 4; // impulse up
			fireButton.style.background = 'rgba(255, 100, 100, 0.3)';

		}

	}

}

/*
=================
Touch_RequestFullscreen

Request fullscreen and lock to landscape orientation on mobile
=================
*/
export async function Touch_RequestFullscreen() {

	if ( fullscreenActivated ) return;

	try {

		// Request fullscreen
		const container = document.documentElement;
		if ( container.requestFullscreen ) {

			await container.requestFullscreen();

		} else if ( container.webkitRequestFullscreen ) {

			await container.webkitRequestFullscreen();

		}

		// Lock to landscape orientation
		if ( screen.orientation && screen.orientation.lock ) {

			try {

				await screen.orientation.lock( 'landscape' );
				console.log( 'Orientation locked to landscape' );

			} catch ( e ) {

				// Orientation lock may not be supported or allowed
				console.log( 'Could not lock orientation:', e.message );

			}

		}

		fullscreenActivated = true;

	} catch ( e ) {

		console.log( 'Could not enter fullscreen:', e.message );

	}

}

/*
=================
Touch_ExitFullscreen

Exit fullscreen mode
=================
*/
export async function Touch_ExitFullscreen() {

	if ( ! document.fullscreenElement && ! document.webkitFullscreenElement ) return;

	try {

		if ( document.exitFullscreen ) {

			await document.exitFullscreen();

		} else if ( document.webkitExitFullscreen ) {

			await document.webkitExitFullscreen();

		}

		// Unlock orientation
		if ( screen.orientation && screen.orientation.unlock ) {

			screen.orientation.unlock();

		}

		fullscreenActivated = false;

	} catch ( e ) {

		console.log( 'Could not exit fullscreen:', e.message );

	}

}

/*
=================
Touch_Init

Initialize touch controls
=================
*/
export function Touch_Init( container ) {

	if ( initialized ) return;

	console.log( 'Touch_Init called, container:', container );

	Touch_CreateUI( container || document.body );

	initialized = true;

	console.log( 'Touch controls initialized' );

}

/*
=================
Touch_Enable

Enable touch controls (show UI, add listeners)
=================
*/
export function Touch_Enable() {

	if ( ! initialized ) {

		console.log( 'Touch_Enable: Failed - not initialized' );
		return;

	}

	if ( enabled ) {

		return; // Already enabled, no need to log

	}

	enabled = true;
	overlay.style.display = 'block';

	console.log( 'Touch_Enable: Touch controls enabled, overlay visible' );

	// Add touch listeners
	joystickArea.addEventListener( 'touchstart', onTouchStart, { passive: false } );
	joystickArea.addEventListener( 'touchmove', onTouchMove, { passive: false } );
	joystickArea.addEventListener( 'touchend', onTouchEnd, { passive: false } );
	joystickArea.addEventListener( 'touchcancel', onTouchEnd, { passive: false } );

	lookArea.addEventListener( 'touchstart', onTouchStart, { passive: false } );
	lookArea.addEventListener( 'touchmove', onTouchMove, { passive: false } );
	lookArea.addEventListener( 'touchend', onTouchEnd, { passive: false } );
	lookArea.addEventListener( 'touchcancel', onTouchEnd, { passive: false } );

	fireButton.addEventListener( 'touchstart', onTouchStart, { passive: false } );
	fireButton.addEventListener( 'touchend', onTouchEnd, { passive: false } );
	fireButton.addEventListener( 'touchcancel', onTouchEnd, { passive: false } );

	pauseButton.addEventListener( 'touchstart', onTouchStart, { passive: false } );

}

/*
=================
Touch_Disable

Disable touch controls (hide UI, remove listeners)
=================
*/
export function Touch_Disable() {

	if ( ! initialized || ! enabled ) return;

	enabled = false;
	overlay.style.display = 'none';

	// Remove touch listeners
	joystickArea.removeEventListener( 'touchstart', onTouchStart );
	joystickArea.removeEventListener( 'touchmove', onTouchMove );
	joystickArea.removeEventListener( 'touchend', onTouchEnd );
	joystickArea.removeEventListener( 'touchcancel', onTouchEnd );

	lookArea.removeEventListener( 'touchstart', onTouchStart );
	lookArea.removeEventListener( 'touchmove', onTouchMove );
	lookArea.removeEventListener( 'touchend', onTouchEnd );
	lookArea.removeEventListener( 'touchcancel', onTouchEnd );

	fireButton.removeEventListener( 'touchstart', onTouchStart );
	fireButton.removeEventListener( 'touchend', onTouchEnd );
	fireButton.removeEventListener( 'touchcancel', onTouchEnd );

	pauseButton.removeEventListener( 'touchstart', onTouchStart );

	// Reset state
	moveTouch = null;
	lookTouch = null;
	moveForward = 0;
	moveRight = 0;
	lookDeltaX = 0;
	lookDeltaY = 0;
	jumpImpulse = false;

}

/*
=================
Touch_IsEnabled
=================
*/
export function Touch_IsEnabled() {

	return enabled;

}

/*
=================
Touch_GetMoveInput

Returns normalized movement input from joystick
=================
*/
export function Touch_GetMoveInput() {

	return { forward: moveForward, right: moveRight };

}

/*
=================
Touch_GetLookDelta

Returns accumulated look delta and clears it
=================
*/
export function Touch_GetLookDelta() {

	const delta = { x: lookDeltaX, y: lookDeltaY };
	lookDeltaX = 0;
	lookDeltaY = 0;
	return delta;

}

/*
=================
Touch_CheckJump

Returns true if jump was triggered (tap on right side)
=================
*/
export function Touch_CheckJump() {

	if ( jumpImpulse ) {

		jumpImpulse = false;
		return true;

	}

	return false;

}

/*
=================
Touch_ShowMenu

Show menu touch overlay
=================
*/
export function Touch_ShowMenu() {

	if ( ! initialized || ! menuOverlay ) return;

	menuOverlay.style.display = 'block';

}

/*
=================
Touch_HideMenu

Hide menu touch overlay
=================
*/
export function Touch_HideMenu() {

	if ( ! initialized || ! menuOverlay ) return;

	menuOverlay.style.display = 'none';

}

/*
=================
Touch_SetMenuCallback

Set the callback function for menu touch events
Callback receives (touchX, touchY, screenWidth, screenHeight)
=================
*/
export function Touch_SetMenuCallback( callback ) {

	menuTouchCallback = callback;

}
