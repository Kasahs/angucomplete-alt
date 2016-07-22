/*
 * angucomplete-alt
 * Autocomplete directive for AngularJS
 * This is a fork of Daryl Rowland's angucomplete with some extra features.
 * By Hidenari Nozaki
 */

/*! Copyright (c) 2014 Hidenari Nozaki and contributors | Licensed under the MIT license */

(function(root, factory) {
    'use strict';
    if (typeof module !== 'undefined' && module.exports) {
        // CommonJS
        module.exports = factory(require('angular'));
    } else if (typeof define === 'function' && define.amd) {
        // AMD
        define(['angular'], factory);
    } else {
        // Global Variables
        factory(root.angular);
    }
}(window, function(angular) {
    'use strict';

    angular.module('angucomplete-alt', [])
        .directive('angucompleteAlt', anguCompleteAltDirective);

    anguCompleteAltDirective.$inject = [
        '$q', '$parse', '$http', '$sce',
        '$timeout', '$templateCache', '$interpolate'
    ];

    function anguCompleteAltDirective($q, $parse, $http, $sce,
        $timeout, $templateCache, $interpolate) {
        // keyboard events
        var KEY_DW = 40;
        var KEY_RT = 39;
        var KEY_UP = 38;
        var KEY_LF = 37;
        var KEY_ES = 27;
        var KEY_EN = 13;
        var KEY_TAB = 9;

        var MIN_LENGTH = 3;
        var MAX_LENGTH = 524288; // the default max length per the html maxlength attribute
        var PAUSE = 500;
        var BLUR_TIMEOUT = 200;

        // string constants
        var REQUIRED_CLASS = 'autocomplete-required';
        var TEXT_SEARCHING = 'Searching...';
        var TEXT_NORESULTS = 'No results found';
        var TEMPLATE_URL = '/angucomplete-alt/index.html';

        // Set the default template for this directive
        var HTML = "";
        HTML += "<div class=\"angucomplete-holder\" ng-class=\"{'angucomplete-dropdown-visible': showDropdown}\">";
        HTML += "    <input id=\"{{id}}_value\" ";
        HTML += "        name=\"{{inputName}}\" ";
        HTML += "        tabindex=\"{{fieldTabindex}}\" ";
        HTML += "        ng-class=\"{'angucomplete-input-not-empty': notEmpty}\" ";
        HTML += "        ng-model=\"searchStr\" ";
        HTML += "        ng-disabled=\"disableInput\" type=\"{{inputType}}\" placeholder=\"{{placeholder}}\" maxlength=\"{{maxlength}}\" ";
        HTML += "        ng-focus=\"onFocusHandler()\" class=\"{{inputClass}}\" ng-focus=\"resetHideResults()\" ng-blur=\"hideResults($event)\" ";
        HTML += "        autocapitalize=\"off\" autocorrect=\"off\" autocomplete=\"off\" ng-change=\"inputChangeHandler(searchStr)\" \/>";
        HTML += "";
        HTML += "    <div id=\"{{id}}_dropdown\" class=\"angucomplete-dropdown\" ng-show=\"showDropdown\">";
        HTML += "        <div class=\"angucomplete-searching\" ng-show=\"searching\" ng-bind=\"textSearching\"><\/div>";
        HTML += "        <div class=\"angucomplete-searching\" ng-show=\"!searching && (!results || results.length == 0)\" ng-bind=\"textNoResults\"><\/div>";
        HTML += "        <div class=\"angucomplete-row\" ng-repeat=\"result in results\" ng-click=\"selectResult(result)\" ng-mouseenter=\"hoverRow($index)\" ng-class=\"{'angucomplete-selected-row': $index == currentIndex}\"> {{result}}";
        HTML += "            <div ng-transclude=\"customTemplate\"> ";
        // HTML += "                <div ng-if=\"imageField\" class=\"angucomplete-image-holder\">";
        // HTML += "                    <img ng-if=\"result.image && result.image != ''\" ng-src=\"{{result.image}}\" class=\"angucomplete-image\" \/>";
        // HTML += "                    <div ng-if=\"!result.image && result.image != ''\" class=\"angucomplete-image-default\"><\/div>";
        // HTML += "                <\/div>";
        // HTML += "                <div class=\"angucomplete-title\" ng-if=\"matchClass\" ng-bind-html=\"result.title\"><\/div>";
        // HTML += "                <div class=\"angucomplete-title\" ng-if=\"!matchClass\">{{ result.title }}<\/div>";
        // HTML += "                <div ng-if=\"matchClass && result.description && result.description != ''\" class=\"angucomplete-description\" ng-bind-html=\"result.description\"><\/div>";
        // HTML += "                <div ng-if=\"!matchClass && result.description && result.description != ''\" class=\"angucomplete-description\">{{result.description}}<\/div>    ";
        HTML += "            <\/div>";
        HTML += "            ";
        HTML += "        <\/div>";
        HTML += "    <\/div>";
        HTML += "<\/div>";
        HTML += "";
        $templateCache.put(TEMPLATE_URL, HTML);


        function link(scope, elem, attrs, ctrl, transclude) {
            var inputField = elem.find('input');
            var minlength = MIN_LENGTH;
            var searchTimer = null;
            var hideTimer;
            var requiredClassName = REQUIRED_CLASS;
            // var responseFormatter;
            var validState = null;
            var httpCanceller = null;
            var dd = elem[0].querySelector('.angucomplete-dropdown');
            var isScrollOn = false;
            var mousedownOn = null;
            var unbindInitialValue;
            var displaySearching;
            var displayNoResults;

            elem.on('mousedown', function(event) {
                if (event.target.id) {
                    mousedownOn = event.target.id;
                    // when mousdown element is this element attach clickoutHandler
                    if (mousedownOn === scope.id + '_dropdown') {
                        document.body.addEventListener('click', clickoutHandlerForDropdown);
                    }
                } else {
                    // maintain handle on mousdown element
                    mousedownOn = event.target.className;
                }
            });

            scope.currentIndex = scope.focusFirst ? 0 : null;
            scope.searching = false;
            unbindInitialValue = scope.$watch('initialValue', function(newval) {
                if (newval) {
                    // remove scope listener
                    unbindInitialValue();
                    // change input
                    handleInputChange(newval, true);
                }
            });

            scope.$watch('fieldRequired', function(newval, oldval) {
                if (newval !== oldval) {
                    if (!newval) {
                        ctrl[scope.inputName].$setValidity(requiredClassName, true);
                    } else if (!validState || scope.currentIndex === -1) {
                        handleRequired(false);
                    } else {
                        handleRequired(true);
                    }
                }
            });

            scope.$on('angucomplete-alt:clearInput', function(event, elementId) {
                if (!elementId || elementId === scope.id) {
                    scope.searchStr = null;
                    callOrAssign();
                    handleRequired(false);
                    clearResults();
                }
            });

            scope.$on('angucomplete-alt:changeInput', function(event, elementId, newval) {
                if (!!elementId && elementId === scope.id) {
                    handleInputChange(newval);
                }
            });

            function handleInputChange(newval, initial) {
                if (newval) {
                    if (typeof newval === 'object') {
                        scope.searchStr = extractTitle(newval);
                        callOrAssign({ originalObject: newval });
                    } else if (typeof newval === 'string' && newval.length > 0) {
                        scope.searchStr = newval;
                    } else {
                        if (console && console.error) {
                            console.error('Tried to set ' + (!!initial ? 'initial' : '') + ' value of angucomplete to', newval, 'which is an invalid value');
                        }
                    }

                    handleRequired(true);
                }
            }

            // #194 dropdown list not consistent in collapsing (bug).
            function clickoutHandlerForDropdown(event) {
                mousedownOn = null;
                scope.hideResults(event);
                document.body.removeEventListener('click', clickoutHandlerForDropdown);
            }

            // for IE8 quirkiness about event.which
            function ie8EventNormalizer(event) {
                return event.which ? event.which : event.keyCode;
            }

            function callOrAssign(value) {
                if (typeof scope.selectedObject === 'function') {
                    scope.selectedObject(value, scope.selectedObjectData);
                } else {
                    scope.selectedObject = value;
                }

                if (value) {
                    handleRequired(true);
                } else {
                    handleRequired(false);
                }
            }

            function callFunctionOrIdentity(fn) {
                return function(data) {
                    return scope[fn] ? scope[fn](data) : data;
                };
            }

            function setInputString(str) {
                callOrAssign({ originalObject: str });

                if (scope.clearSelected) {
                    scope.searchStr = null;
                }
                clearResults();
            }

            function extractTitle(data) {
                // split title fields and run extractValue for each and join with ' '
                return scope.titleField.split(',')
                    .map(function(field) {
                        return extractValue(data, field);
                    })
                    .join(' ');
            }

            function extractValue(obj, key) {
                var keys, result;
                if (key) {
                    keys = key.split('.');
                    result = obj;
                    for (var i = 0; i < keys.length; i++) {
                        result = result[keys[i]];
                    }
                } else {
                    result = obj;
                }
                return result;
            }

            function findMatchString(target, str) {
                var result, matches, re;
                // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions
                // Escape user input to be treated as a literal string within a regular expression
                re = new RegExp(str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
                if (!target) {
                    return; }
                if (!target.match || !target.replace) { target = target.toString(); }
                matches = target.match(re);
                if (matches) {
                    result = target.replace(re,
                        '<span class="' + scope.matchClass + '">' + matches[0] + '</span>');
                } else {
                    result = target;
                }
                return result;
                // return $sce.trustAsHtml(result);
            }

            function handleRequired(valid) {
                scope.notEmpty = valid;
                validState = scope.searchStr;
                if (scope.fieldRequired && ctrl && scope.inputName) {
                    ctrl[scope.inputName].$setValidity(requiredClassName, valid);
                }
            }

            function keyupHandler(event) {
                var which = ie8EventNormalizer(event);
                if (which === KEY_LF || which === KEY_RT) {
                    // do nothing
                    return;
                }

                if (which === KEY_UP || which === KEY_EN) {
                    event.preventDefault();
                } else if (which === KEY_DW) {
                    event.preventDefault();
                    if (!scope.showDropdown && scope.searchStr && scope.searchStr.length >= minlength) {
                        initResults();
                        scope.searching = true;
                        searchTimerComplete(scope.searchStr).then(function(matches) {
                            processResults(matches, scope.searchStr);
                        });
                    }
                } else if (which === KEY_ES) {
                    clearResults();
                    scope.$apply(function() {
                        inputField.val(scope.searchStr);
                    });
                } else {
                    if (minlength === 0 && !scope.searchStr) {
                        return;
                    }

                    if (!scope.searchStr || scope.searchStr === '') {
                        scope.showDropdown = false;
                    } else if (scope.searchStr.length >= minlength) {
                        initResults();

                        if (searchTimer) {
                            $timeout.cancel(searchTimer);
                        }

                        scope.searching = true;

                        searchTimer = $timeout(function() {
                            searchTimerComplete(scope.searchStr).then(function(matches) {
                                processResults(matches, scope.searchStr);
                            });

                        }, scope.pause);
                    }

                    if (validState && validState !== scope.searchStr && !scope.clearSelected) {
                        scope.$apply(function() {
                            callOrAssign();
                        });
                    }
                }
            }

            function handleOverrideSuggestions(event) {
                if (scope.overrideSuggestions &&
                    !(scope.selectedObject && scope.selectedObject.originalObject === scope.searchStr)) {
                    if (event) {
                        event.preventDefault();
                    }

                    // cancel search timer
                    $timeout.cancel(searchTimer);
                    // cancel http request
                    // cancelHttpRequest();

                    setInputString(scope.searchStr);
                }
            }

            function dropdownRowOffsetHeight(row) {
                var css = getComputedStyle(row);
                return row.offsetHeight +
                    parseInt(css.marginTop, 10) + parseInt(css.marginBottom, 10);
            }

            function dropdownHeight() {
                return dd.getBoundingClientRect().top +
                    parseInt(getComputedStyle(dd).maxHeight, 10);
            }

            function dropdownRow() {
                return elem[0].querySelectorAll('.angucomplete-row')[scope.currentIndex];
            }

            function dropdownRowTop() {
                return dropdownRow().getBoundingClientRect().top -
                    (dd.getBoundingClientRect().top +
                        parseInt(getComputedStyle(dd).paddingTop, 10));
            }

            function dropdownScrollTopTo(offset) {
                dd.scrollTop = dd.scrollTop + offset;
            }

            function updateInputField() {
                var current = scope.results[scope.currentIndex];
                if (scope.matchClass) {
                    inputField.val(extractTitle(current.originalObject));
                } else {
                    inputField.val(current.title);
                }
            }

            function keydownHandler(event) {
                var which = ie8EventNormalizer(event);
                var row = null;
                var rowTop = null;

                if (which === KEY_EN && scope.results) {
                    if (scope.currentIndex >= 0 && scope.currentIndex < scope.results.length) {
                        event.preventDefault();
                        scope.selectResult(scope.results[scope.currentIndex]);
                    } else {
                        handleOverrideSuggestions(event);
                        clearResults();
                    }
                    scope.$apply();
                } else if (which === KEY_DW && scope.results) {
                    event.preventDefault();
                    if ((scope.currentIndex + 1) < scope.results.length && scope.showDropdown) {
                        scope.$apply(function() {
                            scope.currentIndex++;
                            updateInputField();
                        });

                        if (isScrollOn) {
                            row = dropdownRow();
                            if (dropdownHeight() < row.getBoundingClientRect().bottom) {
                                dropdownScrollTopTo(dropdownRowOffsetHeight(row));
                            }
                        }
                    }
                } else if (which === KEY_UP && scope.results) {
                    event.preventDefault();
                    if (scope.currentIndex >= 1) {
                        scope.$apply(function() {
                            scope.currentIndex--;
                            updateInputField();
                        });

                        if (isScrollOn) {
                            rowTop = dropdownRowTop();
                            if (rowTop < 0) {
                                dropdownScrollTopTo(rowTop - 1);
                            }
                        }
                    } else if (scope.currentIndex === 0) {
                        scope.$apply(function() {
                            scope.currentIndex = -1;
                            inputField.val(scope.searchStr);
                        });
                    }
                } else if (which === KEY_TAB) {
                    if (scope.results && scope.results.length > 0 && scope.showDropdown) {
                        if (scope.currentIndex === -1 && scope.overrideSuggestions) {
                            // intentionally not sending event so that it does not
                            // prevent default tab behavior
                            handleOverrideSuggestions();
                        } else {
                            if (scope.currentIndex === -1) {
                                scope.currentIndex = 0;
                            }
                            scope.selectResult(scope.results[scope.currentIndex]);
                            scope.$digest();
                        }
                    } else {
                        // no results
                        // intentionally not sending event so that it does not
                        // prevent default tab behavior
                        if (scope.searchStr && scope.searchStr.length > 0) {
                            handleOverrideSuggestions();
                        }
                    }
                } else if (which === KEY_ES) {
                    // This is very specific to IE10/11 #272
                    // without this, IE clears the input text
                    event.preventDefault();
                }
            }


            function clearResults() {
                scope.showDropdown = false;
                scope.results = [];
                if (dd) {
                    dd.scrollTop = 0;
                }
            }


            function initResults() {
                scope.showDropdown = displaySearching;
                scope.currentIndex = scope.focusFirst ? 0 : -1;
                scope.results = [];
            }

            
            function checkExactMatch(result, obj, str) {
                if (!str) {
                    return false; }
                for (var key in obj) {
                    if (obj[key].toLowerCase() === str.toLowerCase()) {
                        scope.selectResult(result);
                        return true;
                    }
                }
                return false;
            }

            function searchTimerComplete(str) {
                if (!str || str.length < minlength) {
                    return $q.when([]);
                }
                if (!scope.searchItems || (typeof scope.searchItems != 'function')) {
                    return $q.when([]);
                }
                return $q.when(scope.searchItems({ searchStr: str }))
                    .then(function(matches) {
                        return matches || [];
                    }, function() {
                        return [];
                    });
            }

            function processResults(responseData, str) {
                var i, description, image, text, formattedText, formattedDesc;

                if (responseData && responseData.length > 0) {
                    scope.results = [];

                    for (i = 0; i < responseData.length; i++) {
                        if (scope.titleField && scope.titleField !== '') {
                            text = formattedText = extractTitle(responseData[i]);
                        }

                        description = '';
                        if (scope.descriptionField) {
                            description = formattedDesc = extractValue(responseData[i], scope.descriptionField);
                        }

                        image = '';
                        if (scope.imageField) {
                            image = extractValue(responseData[i], scope.imageField);
                        }

                        if (scope.matchClass) {
                            formattedText = findMatchString(text, str);
                            formattedDesc = findMatchString(description, str);
                        }

                        scope.results[scope.results.length] = {
                            title: formattedText,
                            description: formattedDesc,
                            image: image,
                            originalObject: responseData[i]
                        };
                    }

                } else {
                    scope.results = [];
                }

                if (scope.autoMatch && scope.results.length === 1 &&
                    checkExactMatch(scope.results[0], { title: text, desc: description || '' }, scope.searchStr)) {
                    scope.showDropdown = false;
                } else if (scope.results.length === 0 && !displayNoResults) {
                    scope.showDropdown = false;
                } else {
                    scope.showDropdown = true;
                }
            }

            function showAll() {
                if (scope.searchItems) {
                    // handle promise and Array as return values
                    $q.when(scope.searchItems({ searchStr: '' }))
                        .then(function(matches) {
                            return matches || [];
                        }, function() {
                            return [];
                        });
                }
                return [];
            }

            scope.onFocusHandler = function() {
                if (scope.focusIn) {
                    scope.focusIn();
                }
                if (minlength === 0 && !scope.searchStr) {
                    scope.currentIndex = scope.focusFirst ? 0 : scope.currentIndex;
                    scope.showDropdown = true;
                    showAll();
                }
            };

            scope.hideResults = function() {
                if (mousedownOn &&
                    (mousedownOn === scope.id + '_dropdown' ||
                        mousedownOn.indexOf('angucomplete') >= 0)) {
                    mousedownOn = null;
                } else {
                    hideTimer = $timeout(function() {
                        clearResults();
                        scope.$apply(function() {
                            if (scope.searchStr && scope.searchStr.length > 0) {
                                inputField.val(scope.searchStr);
                            }
                        });
                    }, BLUR_TIMEOUT);
                    // cancelHttpRequest();

                    if (scope.focusOut) {
                        scope.focusOut();
                    }

                    if (scope.overrideSuggestions) {
                        if (scope.searchStr && scope.searchStr.length > 0 && scope.currentIndex === -1) {
                            handleOverrideSuggestions();
                        }
                    }
                }
            };

            scope.resetHideResults = function() {
                if (hideTimer) {
                    $timeout.cancel(hideTimer);
                }
            };

            scope.hoverRow = function(index) {
                scope.currentIndex = index;
            };

            scope.selectResult = function(result) {
                // Restore original values
                if (scope.matchClass) {
                    result.title = extractTitle(result.originalObject);
                    result.description = extractValue(result.originalObject, scope.descriptionField);
                }

                if (scope.clearSelected) {
                    scope.searchStr = null;
                } else {
                    scope.searchStr = result.title;
                }
                callOrAssign(result);
                clearResults();
            };

            scope.inputChangeHandler = function(str) {
                if (str.length < minlength) {
                    // cancelHttpRequest();
                    clearResults();
                } else if (str.length === 0 && minlength === 0) {
                    scope.searching = false;
                    showAll();
                }

                if (scope.inputChanged) {
                    str = scope.inputChanged(str);
                }
                return str;
            };

            // check required
            if (scope.fieldRequiredClass && scope.fieldRequiredClass !== '') {
                requiredClassName = scope.fieldRequiredClass;
            }

            // check min length
            if (scope.minlength && scope.minlength !== '') {
                minlength = parseInt(scope.minlength, 10);
            }

            // check pause time
            if (!scope.pause) {
                scope.pause = PAUSE;
            }

            // check clearSelected
            if (!scope.clearSelected) {
                scope.clearSelected = false;
            }

            // check override suggestions
            if (!scope.overrideSuggestions) {
                scope.overrideSuggestions = false;
            }

            // check required field
            if (scope.fieldRequired && ctrl) {
                // check initial value, if given, set validitity to true
                if (scope.initialValue) {
                    handleRequired(true);
                } else {
                    handleRequired(false);
                }
            }

            scope.inputType = attrs.type ? attrs.type : 'text';

            // set strings for "Searching..." and "No results"
            scope.textSearching = attrs.textSearching ? attrs.textSearching : TEXT_SEARCHING;
            scope.textNoResults = attrs.textNoResults ? attrs.textNoResults : TEXT_NORESULTS;
            displaySearching = scope.textSearching === 'false' ? false : true;
            displayNoResults = scope.textNoResults === 'false' ? false : true;

            // set max length (default to maxlength deault from html
            scope.maxlength = attrs.maxlength ? attrs.maxlength : MAX_LENGTH;

            // register events
            inputField.on('keydown', keydownHandler);
            inputField.on('keyup', keyupHandler);

            // set response formatter
            // responseFormatter = callFunctionOrIdentity('remoteUrlResponseFormatter');

            // set isScrollOn
            $timeout(function() {
                var css = getComputedStyle(dd);
                isScrollOn = css.maxHeight && css.overflowY === 'auto';
            });
        }

        return {
            restrict: 'EA',
            require: '^?form',
            transclude: {
                customTemplate: '?angucompleteTemplate',
            },
            scope: {
                selectedObject: '=',
                selectedObjectData: '=',
                disableInput: '=',
                initialValue: '=',
                searchItems: '&',
                id: '@',
                type: '@',
                placeholder: '@',
                textSearching: '@',
                textNoResults: '@',
                titleField: '@',
                descriptionField: '@',
                imageField: '@',
                inputClass: '@',
                pause: '@',
                searchFields: '@',
                minlength: '@',
                matchClass: '@',
                clearSelected: '@',
                overrideSuggestions: '@',
                fieldRequired: '=',
                fieldRequiredClass: '@',
                inputChanged: '=',
                autoMatch: '@',
                focusOut: '&',
                focusIn: '&',
                fieldTabindex: '@',
                inputName: '@',
                focusFirst: '@',
                parseInput: '&'
            },
            templateUrl: function(element, attrs) {
                return attrs.templateUrl || TEMPLATE_URL;
            },
            compile: function(tElement) {
                // accomodate different interpolate schemes
                var startSym = $interpolate.startSymbol();
                var endSym = $interpolate.endSymbol();
                if (!(startSym === '{{' && endSym === '}}')) {
                    var interpolatedHtml = tElement.html()
                        .replace(/\{\{/g, startSym)
                        .replace(/\}\}/g, endSym);
                    tElement.html(interpolatedHtml);
                }
                return link;
            }
        };
    };

}));
