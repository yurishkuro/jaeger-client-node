// @flow
// Copyright (c) 2019 Uber Technologies, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except
// in compliance with the License. You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software distributed under the License
// is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express
// or implied. See the License for the specific language governing permissions and limitations under
// the License.

import * as constants from '../../constants.js';
import Span from '../../span';
import BaseSamplerV2 from './base';

export default class ConstSamplerV2 extends BaseSamplerV2 {
  _cachedDecision: SamplingDecision;

  constructor(decision: boolean) {
    super('ConstSampler');
    const tags = {};
    tags[constants.SAMPLER_TYPE_TAG_KEY] = constants.SAMPLER_TYPE_CONST;
    tags[constants.SAMPLER_PARAM_TAG_KEY] = Boolean(decision);
    this._cachedDecision = {
      sample: Boolean(decision),
      retryable: false,
      tags: tags,
    };
  }

  toString() {
    return `${this.name()}(version=2, ${this._cachedDecision ? 'always' : 'never'})`;
  }

  get decision() {
    return this._cachedDecision.sample;
  }

  onCreateSpan(span: Span): SamplingDecision {
    return this._cachedDecision;
  }

  onSetOperationName(span: Span, operationName: string): SamplingDecision {
    return this._cachedDecision;
  }
}
