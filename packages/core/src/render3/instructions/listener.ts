/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */


import {assertDataInRange} from '../../util/assert';
import {isObservable} from '../../util/lang';
import {PropertyAliasValue, TNode, TNodeFlags, TNodeType} from '../interfaces/node';
import {GlobalTargetResolver, RElement, Renderer3, isProceduralRenderer} from '../interfaces/renderer';
import {CLEANUP, FLAGS, LView, LViewFlags, RENDERER, TVIEW} from '../interfaces/view';
import {assertNodeOfPossibleTypes} from '../node_assert';
import {getLView, getPreviousOrParentTNode} from '../state';
import {getComponentViewByIndex, getNativeByTNode, unwrapRNode} from '../util/view_utils';
import {BindingDirection, generatePropertyAliases, getCleanup, handleError, loadComponentRenderer, markViewDirty} from './shared';

/**
 * Adds an event listener to the current node.
 *
 * If an output exists on one of the node's directives, it also subscribes to the output
 * and saves the subscription for later cleanup.
 *
 * @param eventName Name of the event
 * @param listenerFn The function to be called when event emits
 * @param useCapture Whether or not to use capture in event listener
 * @param eventTargetResolver Function that returns global target information in case this listener
 * should be attached to a global object like window, document or body
 *
 * @codeGenApi
 */
export function Δlistener(
    eventName: string, listenerFn: (e?: any) => any, useCapture = false,
    eventTargetResolver?: GlobalTargetResolver): void {
  listenerInternal(eventName, listenerFn, useCapture, eventTargetResolver);
}

/**
* Registers a synthetic host listener (e.g. `(@foo.start)`) on a component.
*
* This instruction is for compatibility purposes and is designed to ensure that a
* synthetic host listener (e.g. `@HostListener('@foo.start')`) properly gets rendered
* in the component's renderer. Normally all host listeners are evaluated with the
* parent component's renderer, but, in the case of animation @triggers, they need
* to be evaluated with the sub component's renderer (because that's where the
* animation triggers are defined).
*
* Do not use this instruction as a replacement for `listener`. This instruction
* only exists to ensure compatibility with the ViewEngine's host binding behavior.
*
* @param eventName Name of the event
* @param listenerFn The function to be called when event emits
* @param useCapture Whether or not to use capture in event listener
* @param eventTargetResolver Function that returns global target information in case this listener
* should be attached to a global object like window, document or body
 *
 * @codeGenApi
*/
export function ΔcomponentHostSyntheticListener<T>(
    eventName: string, listenerFn: (e?: any) => any, useCapture = false,
    eventTargetResolver?: GlobalTargetResolver): void {
  listenerInternal(eventName, listenerFn, useCapture, eventTargetResolver, loadComponentRenderer);
}

/**
 * A utility function that checks if a given element has already an event handler registered for an
 * event with a specified name. The TView.cleanup data structure is used to find out which events
 * are registered for a given element.
 */
function findExistingListener(
    lView: LView, eventName: string, tNodeIdx: number): ((e?: any) => any)|null {
  const tView = lView[TVIEW];
  const tCleanup = tView.cleanup;
  if (tCleanup != null) {
    for (let i = 0; i < tCleanup.length - 1; i += 2) {
      if (tCleanup[i] === eventName && tCleanup[i + 1] === tNodeIdx) {
        // We have found a matching event name on the same node but it might not have been
        // registered yet, so we must explicitly verify entries in the LView cleanup data
        // structures.
        const lCleanup = lView[CLEANUP] !;
        const listenerIdxInLCleanup = tCleanup[i + 2];
        return lCleanup.length > listenerIdxInLCleanup ? lCleanup[listenerIdxInLCleanup] : null;
      }
      // TView.cleanup can have a mix of 4-elements entries (for event handler cleanups) or
      // 2-element entries (for directive and queries destroy hooks). As such we can encounter
      // blocks of 4 or 2 items in the tView.cleanup and this is why we iterate over 2 elements
      // first and jump another 2 elements if we detect listeners cleanup (4 elements). Also check
      // documentation of TView.cleanup for more details of this data structure layout.
      i += 2;
    }
  }
  return null;
}

function listenerInternal(
    eventName: string, listenerFn: (e?: any) => any, useCapture = false,
    eventTargetResolver?: GlobalTargetResolver,
    loadRendererFn?: ((tNode: TNode, lView: LView) => Renderer3) | null): void {
  const lView = getLView();
  const tNode = getPreviousOrParentTNode();
  const tView = lView[TVIEW];
  const firstTemplatePass = tView.firstTemplatePass;
  const tCleanup: false|any[] = firstTemplatePass && (tView.cleanup || (tView.cleanup = []));

  ngDevMode && assertNodeOfPossibleTypes(
                   tNode, TNodeType.Element, TNodeType.Container, TNodeType.ElementContainer);

  // add native event listener - applicable to elements only
  if (tNode.type === TNodeType.Element) {
    const native = getNativeByTNode(tNode, lView) as RElement;
    const resolved = eventTargetResolver ? eventTargetResolver(native) : {} as any;
    const target = resolved.target || native;
    const renderer = loadRendererFn ? loadRendererFn(tNode, lView) : lView[RENDERER];
    const lCleanup = getCleanup(lView);
    const lCleanupIndex = lCleanup.length;
    const idxOrTargetGetter = eventTargetResolver ?
        (_lView: LView) => eventTargetResolver(unwrapRNode(_lView[tNode.index])).target :
        tNode.index;

    // In order to match current behavior, native DOM event listeners must be added for all
    // events (including outputs).
    if (isProceduralRenderer(renderer)) {
      // There might be cases where multiple directives on the same element try to register an event
      // handler function for the same event. In this situation we want to avoid registration of
      // several native listeners as each registration would be intercepted by NgZone and
      // trigger change detection. This would mean that a single user action would result in several
      // change detections being invoked. To avoid this situation we want to have only one call to
      // native handler registration (for the same element and same type of event).
      //
      // In order to have just one native event handler in presence of multiple handler functions,
      // we just register a first handler function as a native event listener and then chain
      // (coalesce) other handler functions on top of the first native handler function.
      //
      // Please note that the coalescing described here doesn't happen for events specifying an
      // alternative target (ex. (document:click)) - this is to keep backward compatibility with the
      // view engine.
      const existingListener =
          eventTargetResolver ? null : findExistingListener(lView, eventName, tNode.index);
      if (existingListener !== null) {
        // Attach a new listener at the head of the coalesced listeners list.
        (<any>listenerFn).__ngNextListenerFn__ = (<any>existingListener).__ngNextListenerFn__;
        (<any>existingListener).__ngNextListenerFn__ = listenerFn;
      } else {
        // The first argument of `listen` function in Procedural Renderer is:
        // - either a target name (as a string) in case of global target (window, document, body)
        // - or element reference (in all other cases)
        listenerFn = wrapListener(tNode, lView, listenerFn, false /** preventDefault */);
        const cleanupFn = renderer.listen(resolved.name || target, eventName, listenerFn);
        ngDevMode && ngDevMode.rendererAddEventListener++;

        lCleanup.push(listenerFn, cleanupFn);
        tCleanup && tCleanup.push(eventName, idxOrTargetGetter, lCleanupIndex, lCleanupIndex + 1);
      }

    } else {
      listenerFn = wrapListener(tNode, lView, listenerFn, true /** preventDefault */);
      target.addEventListener(eventName, listenerFn, useCapture);
      ngDevMode && ngDevMode.rendererAddEventListener++;

      lCleanup.push(listenerFn);
      tCleanup && tCleanup.push(eventName, idxOrTargetGetter, lCleanupIndex, useCapture);
    }
  }

  // subscribe to directive outputs
  if (tNode.outputs === undefined) {
    // if we create TNode here, inputs must be undefined so we know they still need to be
    // checked
    tNode.outputs = generatePropertyAliases(tNode, BindingDirection.Output);
  }

  const outputs = tNode.outputs;
  let props: PropertyAliasValue|undefined;
  if (outputs && (props = outputs[eventName])) {
    const propsLength = props.length;
    if (propsLength) {
      const lCleanup = getCleanup(lView);
      for (let i = 0; i < propsLength; i += 3) {
        const index = props[i] as number;
        ngDevMode && assertDataInRange(lView, index);
        const minifiedName = props[i + 2];
        const directiveInstance = lView[index];
        const output = directiveInstance[minifiedName];

        if (ngDevMode && !isObservable(output)) {
          throw new Error(
              `@Output ${minifiedName} not initialized in '${directiveInstance.constructor.name}'.`);
        }

        const subscription = output.subscribe(listenerFn);
        const idx = lCleanup.length;
        lCleanup.push(listenerFn, subscription);
        tCleanup && tCleanup.push(eventName, tNode.index, idx, -(idx + 1));
      }
    }
  }
}

function executeListenerWithErrorHandling(lView: LView, listenerFn: (e?: any) => any, e: any): any {
  try {
    return listenerFn(e);
  } catch (error) {
    handleError(lView, error);
    return false;
  }
}

/**
 * Wraps an event listener with a function that marks ancestors dirty and prevents default behavior,
 * if applicable.
 *
 * @param tNode The TNode associated with this listener
 * @param lView The LView that contains this listener
 * @param listenerFn The listener function to call
 * @param wrapWithPreventDefault Whether or not to prevent default behavior
 * (the procedural renderer does this already, so in those cases, we should skip)
 */
function wrapListener(
    tNode: TNode, lView: LView, listenerFn: (e?: any) => any,
    wrapWithPreventDefault: boolean): EventListener {
  // Note: we are performing most of the work in the listener function itself
  // to optimize listener registration.
  return function wrapListenerIn_markDirtyAndPreventDefault(e: Event) {
    // In order to be backwards compatible with View Engine, events on component host nodes
    // must also mark the component view itself dirty (i.e. the view that it owns).
    const startView =
        tNode.flags & TNodeFlags.isComponent ? getComponentViewByIndex(tNode.index, lView) : lView;

    // See interfaces/view.ts for more on LViewFlags.ManualOnPush
    if ((lView[FLAGS] & LViewFlags.ManualOnPush) === 0) {
      markViewDirty(startView);
    }

    let result = executeListenerWithErrorHandling(lView, listenerFn, e);
    // A just-invoked listener function might have coalesced listeners so we need to check for
    // their presence and invoke as needed.
    let nextListenerFn = (<any>wrapListenerIn_markDirtyAndPreventDefault).__ngNextListenerFn__;
    while (nextListenerFn) {
      result = executeListenerWithErrorHandling(lView, nextListenerFn, e);
      nextListenerFn = (<any>nextListenerFn).__ngNextListenerFn__;
    }

    if (wrapWithPreventDefault && result === false) {
      e.preventDefault();
      // Necessary for legacy browsers that don't support preventDefault (e.g. IE)
      e.returnValue = false;
    }

    return result;
  };
}
