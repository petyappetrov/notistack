import React, { Component } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import SnackbarContext from '../SnackbarContext';
import { CloseReason, originKeyExtractor, DEFAULTS, merge, isDefined } from '../utils/constants';
import SnackbarItem from '../SnackbarItem';
import SnackbarContainer from '../SnackbarContainer';
import warning from '../utils/warning';
import { SnackbarProviderProps, SnackbarKey, ProviderContext, TransitionHandlerProps, InternalSnack, OptionsObject, SharedProps } from '../types';
import createChainedFunction from '../utils/createChainedFunction';

const isOptions = (messageOrOptions: string | (OptionsObject & { message?: string })): messageOrOptions is OptionsObject & { message?: string } => (
    typeof messageOrOptions !== 'string'
);

type Reducer = (state: State) => State;
type SnacksByPosition = { [key: string]: InternalSnack[] };

interface State {
    snacks: InternalSnack[];
    queue: InternalSnack[];
    contextValue: ProviderContext;
}

class SnackbarProvider extends Component<SnackbarProviderProps, State> {
    constructor(props: SnackbarProviderProps) {
        super(props);
        this.state = {
            snacks: [],
            queue: [], // eslint-disable-line react/no-unused-state
            contextValue: {
                enqueueSnackbar: this.enqueueSnackbar,
                closeSnackbar: this.closeSnackbar,
            },
        };
    }

    get maxSnack(): number {
        return this.props.maxSnack || DEFAULTS.maxSnack;
    }

    /**
     * Adds a new snackbar to the queue to be presented.
     * Returns generated or user defined key referencing the new snackbar or null
     */
    enqueueSnackbar = (messageOrOptions: string | (OptionsObject & { message?: string }), optsOrUndefined: OptionsObject = {}): SnackbarKey => {
        const opts = isOptions(messageOrOptions) ? messageOrOptions : optsOrUndefined;

        let message: string | undefined = messageOrOptions as string;
        if (isOptions(messageOrOptions)) {
            message = messageOrOptions.message;
        }

        const {
            key,
            preventDuplicate,
            ...options
        } = opts;

        const hasSpecifiedKey = isDefined(key);
        const id = hasSpecifiedKey ? (key as SnackbarKey) : new Date().getTime() + Math.random();

        const merger = merge(options, this.props);
        const snack: InternalSnack = {
            id,
            ...options,
            message,
            open: true,
            entered: false,
            requestClose: false,
            persist: merger('persist'),
            action: merger('action'),
            content: merger('content'),
            variant: merger('variant'),
            anchorOrigin: merger('anchorOrigin'),
            disableWindowBlurListener: merger('disableWindowBlurListener'),
            autoHideDuration: merger('autoHideDuration'),
            hideIconVariant: merger('hideIconVariant'),
            TransitionComponent: merger('TransitionComponent'),
            transitionDuration: merger('transitionDuration'),
            TransitionProps: merger('TransitionProps', true),
            iconVariant: merger('iconVariant', true),
            style: merger('style', true),
            SnackbarProps: merger('SnackbarProps', true),
            className: clsx(this.props.className, options.className),
        };

        if (snack.persist) {
            snack.autoHideDuration = undefined;
        }

        this.setState((state) => {
            if ((preventDuplicate === undefined && this.props.preventDuplicate) || preventDuplicate) {
                const compareFunction = (item: InternalSnack): boolean => (
                    hasSpecifiedKey ? item.id === id : item.message === message
                );

                const inQueue = state.queue.findIndex(compareFunction) > -1;
                const inView = state.snacks.findIndex(compareFunction) > -1;
                if (inQueue || inView) {
                    return state;
                }
            }

            return this.handleDisplaySnack({
                ...state,
                queue: [...state.queue, snack],
            });
        });

        return id;
    }

    /**
     * Reducer: Display snack if there's space for it. Otherwise, immediately
     * begin dismissing the oldest message to start showing the new one.
     */
    handleDisplaySnack: Reducer = (state) => {
        const { snacks } = state;
        if (snacks.length >= this.maxSnack) {
            return this.handleDismissOldest(state);
        }
        return this.processQueue(state);
    };

    /**
     * Reducer: Display items (notifications) in the queue if there's space for them.
     */
    processQueue: Reducer = (state) => {
        const { queue, snacks } = state;
        if (queue.length > 0) {
            return {
                ...state,
                snacks: [...snacks, queue[0]],
                queue: queue.slice(1, queue.length),
            };
        }
        return state;
    };

    /**
     * Reducer: Hide oldest snackbar on the screen because there exists a new one which we have to display.
     * (ignoring the one with 'persist' flag. i.e. explicitly told by user not to get dismissed).
     *
     * Note 1: If there is already a message leaving the screen, no new messages are dismissed.
     * Note 2: If the oldest message has not yet entered the screen, only a request to close the
     *         snackbar is made. Once it entered the screen, it will be immediately dismissed.
     */
    handleDismissOldest: Reducer = (state) => {
        if (state.snacks.some((item) => !item.open || item.requestClose)) {
            return state;
        }

        let popped = false;
        let ignore = false;

        const persistentCount = state.snacks.reduce((acc, current) => (
            acc + (current.open && current.persist ? 1 : 0)
        ), 0);

        if (persistentCount === this.maxSnack) {
            warning('NO_PERSIST_ALL');
            ignore = true;
        }

        const snacks = state.snacks.map((item) => {
            if (!popped && (!item.persist || ignore)) {
                popped = true;

                if (!item.entered) {
                    return {
                        ...item,
                        requestClose: true,
                    };
                }

                if (item.onClose) {
                    item.onClose(null, CloseReason.MaxSnack, item.id);
                }

                if (this.props.onClose) {
                    this.props.onClose(null, CloseReason.MaxSnack, item.id);
                }

                return {
                    ...item,
                    open: false,
                };
            }

            return { ...item };
        });

        return { ...state, snacks };
    };

    /**
     * Set the entered state of the snackbar with the given key.
     */
    handleEnteredSnack: TransitionHandlerProps['onEntered'] = (node, isAppearing, key) => {
        if (!isDefined(key)) {
            throw new Error('handleEnteredSnack Cannot be called with undefined key');
        }

        this.setState(({ snacks }) => ({
            snacks: snacks.map((item) => (
                item.id === key ? { ...item, entered: true } : { ...item }
            )),
        }));
    }

    /**
     * Hide a snackbar after its timeout.
     */
    handleCloseSnack: NonNullable<SharedProps['onClose']> = (event, reason, key) => {
        // should not use createChainedFunction for onClose.
        // because this.closeSnackbar called this function
        if (this.props.onClose) {
            this.props.onClose(event, reason, key);
        }

        if (reason === CloseReason.ClickAway) {
            return;
        }

        const shouldCloseAll = key === undefined;

        this.setState(({ snacks, queue }) => ({
            snacks: snacks.map((item) => {
                if (!shouldCloseAll && item.id !== key) {
                    return { ...item };
                }

                return item.entered
                    ? { ...item, open: false }
                    : { ...item, requestClose: true };
            }),
            queue: queue.filter((item) => item.id !== key), // eslint-disable-line react/no-unused-state
        }));
    };

    /**
     * Close snackbar with the given key
     */
    closeSnackbar: ProviderContext['closeSnackbar'] = (key) => {
        // call individual snackbar onClose callback passed through options parameter
        const toBeClosed = this.state.snacks.find((item) => item.id === key);
        if (isDefined(key) && toBeClosed && toBeClosed.onClose) {
            toBeClosed.onClose(null, CloseReason.Instructed, key);
        }

        this.handleCloseSnack(null, CloseReason.Instructed, key);
    }

    /**
     * When we set open attribute of a snackbar to false (i.e. after we hide a snackbar),
     * it leaves the screen and immediately after leaving animation is done, this method
     * gets called. We remove the hidden snackbar from state and then display notifications
     * waiting in the queue (if any). If after this process the queue is not empty, the
     * oldest message is dismissed.
     */
    handleExitedSnack: TransitionHandlerProps['onExited'] = (event, key) => {
        if (!isDefined(key)) {
            throw new Error('handleExitedSnack Cannot be called with undefined key');
        }

        this.setState((state) => {
            const newState = this.processQueue({
                ...state,
                snacks: state.snacks.filter((item) => item.id !== key),
            });

            if (newState.queue.length === 0) {
                return newState;
            }

            return this.handleDismissOldest(newState);
        });
    };

    render(): JSX.Element {
        const { contextValue } = this.state;
        const {
            domRoot,
            children,
            dense = false,
            Components = {},
            classes,
        } = this.props;

        const categ = this.state.snacks.reduce<SnacksByPosition>((acc, current) => {
            const category = originKeyExtractor(current.anchorOrigin);
            const existingOfCategory = acc[category] || [];
            return {
                ...acc,
                [category]: [...existingOfCategory, current],
            };
        }, {});

        const snackbars = Object.keys(categ).map((origin) => {
            const snacks = categ[origin];
            const [nomineeSnack] = snacks;
            return (
                <SnackbarContainer
                    key={origin}
                    dense={dense}
                    anchorOrigin={nomineeSnack.anchorOrigin}
                    classes={classes}
                >
                    {snacks.map((snack) => (
                        <SnackbarItem
                            key={snack.id}
                            snack={snack}
                            classes={classes}
                            Component={Components[snack.variant]}
                            onClose={this.handleCloseSnack}
                            onEnter={this.props.onEnter}
                            onExit={this.props.onExit}
                            onExited={createChainedFunction([this.handleExitedSnack, this.props.onExited])}
                            onEntered={createChainedFunction([this.handleEnteredSnack, this.props.onEntered])}
                        />
                    ))}
                </SnackbarContainer>
            );
        });

        return (
            <SnackbarContext.Provider value={contextValue}>
                {children}
                {domRoot ? createPortal(snackbars, domRoot) : snackbars}
            </SnackbarContext.Provider>
        );
    }
}

export default SnackbarProvider;
