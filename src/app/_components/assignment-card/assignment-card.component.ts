import { Component, OnInit, Input, Output, EventEmitter } from '@angular/core';
import { FormGroup } from '@angular/forms';
import { ReferenceComponent } from '../reference/reference.component';

@Component({
  selector: 'app-assignment-card',
  templateUrl: './assignment-card.component.html',
  styleUrls: ['./assignment-card.component.scss'],
})
export class AssignmentCardComponent implements OnInit {
  @Input() pConn$: any;
  @Input() formGroup$: FormGroup;
  @Input() arMainButtons$: Array<any>;
  @Input() arSecondaryButtons$: Array<any>;
  @Input() arChildren$: Array<any>;
  @Input() updateToken$: number;

  @Output() ActionButtonClick: EventEmitter<any> = new EventEmitter();

  constructor() {}

  ngOnInit(): void {
    // Children may contain 'reference' component, so we need to
    //  normalize them
    this.arChildren$ = ReferenceComponent.normalizePConnArray(this.arChildren$);
  }

  ngOnChanges(data: any) {
    // Children may contain 'reference' component, so we need to
    //  normalize them
    this.arChildren$ = ReferenceComponent.normalizePConnArray(this.arChildren$);
  }

  onActionButtonClick(oData: any) {
    this.ActionButtonClick.emit(oData);
  }
}
