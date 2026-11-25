import js from '@eslint/js';
import globals from 'globals';

export default [
    {
        ignores: [
            'node_modules/**',
            'public/vendor/**',
            'public/js/socket.io.min.js',
            'src-tauri/**',
            'dist/**'
        ]
    },
    js.configs.recommended,
    {
        rules: {
            'no-unused-vars': ['error', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrorsIgnorePattern: '^_'
            }],
            'no-empty': ['error', { allowEmptyCatch: true }]
        }
    },
    {
        files: ['eslint.config.mjs'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: globals.node
        }
    },
    {
        files: ['server.js', 'src/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: globals.node
        }
    },
    {
        files: ['public/app.js', 'public/js/modules/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                ...globals.browser,
                io: 'readonly'
            }
        },
        rules: {
            'no-restricted-syntax': [
                'error',
                {
                    selector: 'MemberExpression[property.name="cssText"]',
                    message: 'Uso de cssText proibido pela CSP style-src estrita; use classes CSS em style.css.'
                },
                {
                    selector: 'CallExpression[callee.property.name="setAttribute"][arguments.0.value="style"]',
                    message: 'Uso de setAttribute("style", ...) proibido pela CSP style-src estrita; use classes CSS em style.css.'
                },
                {
                    selector: 'AssignmentExpression[left.object.property.name="style"]',
                    message: 'Mutação direta de element.style.* proibida; use o atributo hidden ou classes CSS em style.css.'
                },
                {
                    selector: 'CallExpression[callee.object.property.name="style"]',
                    message: 'Mutação direta via element.style.*() proibida; use o atributo hidden ou classes CSS em style.css.'
                }
            ]
        }
    },
    {
        files: ['public/js/desktop-bridge.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: {
                ...globals.browser,
                module: 'readonly',
                globalThis: 'readonly'
            }
        }
    },
    {
        files: ['public/js/audio-worklet-processor.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script',
            globals: {
                ...globals.browser,
                AudioWorkletProcessor: 'readonly',
                registerProcessor: 'readonly',
                sampleRate: 'readonly',
                currentFrame: 'readonly',
                currentTime: 'readonly'
            }
        }
    },
    {
        files: ['test/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: {
                ...globals.node,
                ...globals.browser
            }
        }
    }
];
